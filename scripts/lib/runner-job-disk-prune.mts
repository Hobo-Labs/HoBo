const GIB = 1024 * 1024 * 1024;
const DOCKER_ROOT_FORMAT = "{{.DockerRootDir}}";

export const DEFAULT_RUNNER_DISK_HEADROOM_GB = 12;

export function runnerDiskHeadroomBytes(raw: string | undefined): number {
	const text = raw?.trim() ?? "";
	if (text === "") return DEFAULT_RUNNER_DISK_HEADROOM_GB * GIB;
	if (!/^\d+$/u.test(text)) {
		throw new Error("invalid HOBO_CI_RUNNER_DISK_HEADROOM_GB");
	}
	const gigabytes = Number(text);
	if (!Number.isSafeInteger(gigabytes) || gigabytes < 1) {
		throw new Error("invalid HOBO_CI_RUNNER_DISK_HEADROOM_GB");
	}
	const bytes = gigabytes * GIB;
	if (!Number.isSafeInteger(bytes)) {
		throw new Error("invalid HOBO_CI_RUNNER_DISK_HEADROOM_GB");
	}
	return bytes;
}

export function parseDfAvailBytes(stdout: string): number {
	const line = stdout.trim().split("\n").at(-1)?.trim() ?? "";
	if (!/^\d+$/u.test(line)) throw new Error("invalid df avail sample");
	const bytes = Number(line);
	if (!Number.isSafeInteger(bytes)) throw new Error("invalid df avail sample");
	return bytes;
}

export function jobDiskSamplePath(
	githubWorkspace: string | undefined,
	cwd: string,
): string {
	const workspace = githubWorkspace?.trim();
	return workspace ? workspace : cwd;
}

export type DockerCommandResult = Readonly<{
	status: number | null;
	stdout: string;
	stderr: string;
	error?: string;
}>;

export type RunnerDiskPruneIo = Readonly<{
	sample: (path: string) => number;
	docker: (args: readonly string[]) => DockerCommandResult;
	dockerAvailable: boolean;
	log: (message: string) => void;
	warn: (message: string) => void;
}>;

type DiskLabel = "dockerRoot" | "workspace";

type DiskSample = Readonly<{
	label: DiskLabel;
	path: string | undefined;
	availableBytes: number | undefined;
}>;

function errorText(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function commandOk(result: DockerCommandResult): boolean {
	return result.error === undefined && result.status === 0;
}

function commandDetail(result: DockerCommandResult): string {
	return (
		result.error ??
		(result.stderr.trim() || `status ${result.status ?? "unknown"}`)
	);
}

function dockerDataRoot(io: RunnerDiskPruneIo): string | undefined {
	if (!io.dockerAvailable) return undefined;
	const result = io.docker(["info", "-f", DOCKER_ROOT_FORMAT]);
	if (!commandOk(result)) {
		io.warn(
			`runner-job-disk-prune: docker info failed: ${commandDetail(result)}`,
		);
		return undefined;
	}
	const path = result.stdout.trim();
	if (!path.startsWith("/") || /\s/u.test(path)) {
		io.warn("runner-job-disk-prune: invalid DockerRootDir");
		return undefined;
	}
	return path;
}

function takeSample(
	io: RunnerDiskPruneIo,
	label: DiskLabel,
	path: string | undefined,
): DiskSample {
	if (path === undefined) return { label, path, availableBytes: undefined };
	try {
		return { label, path, availableBytes: io.sample(path) };
	} catch (error) {
		io.warn(
			`runner-job-disk-prune: df sample failed path=${path}: ${errorText(error)}`,
		);
		return { label, path, availableBytes: undefined };
	}
}

function formatSample(sample: DiskSample): string {
	if (sample.path === undefined) return `${sample.label}=unavailable`;
	const avail =
		sample.availableBytes === undefined
			? "unavailable"
			: String(sample.availableBytes);
	return `${sample.label}=${sample.path} avail=${avail}`;
}

function logDf(
	io: RunnerDiskPruneIo,
	phase: "before" | "after",
	dockerRoot: DiskSample,
	workspace: DiskSample,
	need: number,
): void {
	io.log(
		`runner-job-disk-prune: ${phase} df ${formatSample(dockerRoot)} ${formatSample(workspace)} need=${need}`,
	);
}

function belowHeadroom(sample: DiskSample, need: number): boolean {
	return sample.availableBytes !== undefined && sample.availableBytes < need;
}

function pruneBuilderCache(io: RunnerDiskPruneIo): void {
	const builder = io.docker([
		"builder",
		"prune",
		"--force",
		"--filter",
		"until=24h",
		"--keep-storage",
		"4GB",
	]);
	if (!commandOk(builder)) {
		io.warn("runner-job-disk-prune: builder prune failed");
	}
}

export function executeRunnerJobDiskPrune(
	env: Readonly<Record<string, string | undefined>>,
	cwd: string,
	io: RunnerDiskPruneIo,
): number {
	if (env.RUNNER_ENVIRONMENT !== "self-hosted") {
		io.log(
			`runner-job-disk-prune: skipped (RUNNER_ENVIRONMENT=${env.RUNNER_ENVIRONMENT ?? "unset"})`,
		);
		return 0;
	}
	let headroomBytes: number;
	try {
		headroomBytes = runnerDiskHeadroomBytes(
			env.HOBO_CI_RUNNER_DISK_HEADROOM_GB,
		);
	} catch (error) {
		io.warn(errorText(error));
		return 1;
	}
	const workspacePath = jobDiskSamplePath(env.GITHUB_WORKSPACE, cwd);
	const dockerRootPath = dockerDataRoot(io);
	const beforeDocker = takeSample(io, "dockerRoot", dockerRootPath);
	const beforeWorkspace = takeSample(io, "workspace", workspacePath);
	logDf(io, "before", beforeDocker, beforeWorkspace, headroomBytes);
	const lowDocker = belowHeadroom(beforeDocker, headroomBytes);
	const lowWorkspace = belowHeadroom(beforeWorkspace, headroomBytes);
	if (!lowDocker && !lowWorkspace) {
		if (
			beforeDocker.availableBytes !== undefined ||
			beforeWorkspace.availableBytes !== undefined
		) {
			io.log("runner-job-disk-prune: headroom ok");
		}
		return 0;
	}
	if (!io.dockerAvailable) {
		io.warn(`runner-job-disk-prune: docker unavailable; need=${headroomBytes}`);
		return 0;
	}
	const lowLabels: string[] = [];
	if (lowDocker) lowLabels.push(beforeDocker.label);
	if (lowWorkspace) lowLabels.push(beforeWorkspace.label);
	io.log(
		`runner-job-disk-prune: headroom low ${lowLabels.join(",")}; pruning stale builder cache`,
	);
	pruneBuilderCache(io);
	const afterDocker = takeSample(io, "dockerRoot", dockerRootPath);
	const afterWorkspace = takeSample(io, "workspace", workspacePath);
	logDf(io, "after", afterDocker, afterWorkspace, headroomBytes);
	if (
		belowHeadroom(afterDocker, headroomBytes) ||
		belowHeadroom(afterWorkspace, headroomBytes)
	) {
		io.warn(
			`runner-job-disk-prune: still below headroom need=${headroomBytes}`,
		);
	}
	return 0;
}
