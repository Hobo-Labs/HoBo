import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MachineIsolation } from "@hobo/ci";
import {
	RUNNER_VERSION,
	runHostProcess,
	runnerDownloadFor,
	runnerEnvironment,
} from "../bootstrap.js";
import {
	RUNNER_EXIT_CODE_PATH,
	RUNNER_EXITED_PATH,
	startRunner,
} from "../isolated-worker/container-controller.js";
import type { DockerDriver } from "../isolated-worker/docker-driver.js";

export type MachineJobRun = Readonly<{
	name: string;
	encodedJitConfig: string;
	signal: AbortSignal;
}>;

export type MachineJobOutcome = Readonly<{
	exitCode: number | undefined;
	stopped: boolean;
}>;

export interface JobExecutor {
	readonly isolation: MachineIsolation;
	run(job: MachineJobRun): Promise<MachineJobOutcome>;
}

export const RUNNER_JIT_CONFIG_ENV = "ACTIONS_RUNNER_INPUT_JITCONFIG";

export function containerJobEnvironment(
	env: NodeJS.ProcessEnv,
	arch: string,
): ReadonlyMap<string, string> {
	const download = runnerDownloadFor(arch);
	const result = new Map<string, string>([
		["HOBO_CI_RUNNER_URL", download.url],
		["HOBO_CI_RUNNER_SHA256", download.sha256],
	]);
	for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "LANG"]) {
		const value = env[name];
		if (value !== undefined) result.set(name, value);
	}
	return result;
}

export function hostJobEnvironment(
	env: NodeJS.ProcessEnv,
	encodedJitConfig: string,
): NodeJS.ProcessEnv {
	return {
		...runnerEnvironment(env),
		[RUNNER_JIT_CONFIG_ENV]: encodedJitConfig,
	};
}

export function pause(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

export const DEFAULT_MACHINE_IMAGE = `ghcr.io/actions/actions-runner:${RUNNER_VERSION}`;
export const MACHINE_JOB_TIMEOUT_MS = 360 * 60_000;

export function containerExecutor(
	options: Readonly<{
		docker: DockerDriver;
		image: string;
		arch: string;
		env: NodeJS.ProcessEnv;
		pollMs?: number;
		wait?: (ms: number, signal: AbortSignal) => Promise<void>;
		now?: () => number;
		timeoutMs?: number;
	}>,
): JobExecutor {
	const { docker } = options;
	const wait = options.wait ?? pause;
	const now = options.now ?? Date.now;
	const timeoutMs = options.timeoutMs ?? MACHINE_JOB_TIMEOUT_MS;
	return {
		isolation: "container",
		async run(job) {
			if (!docker.exists || !docker.writeSecret)
				throw new Error(
					"the container driver cannot deliver a secret or see the runner exit",
				);
			const handle = await docker.create({
				name: job.name,
				image: options.image,
				timeoutMs,
				env: Object.fromEntries(
					containerJobEnvironment(options.env, options.arch),
				),
				command: ["sleep", "infinity"],
			});
			const startedMs = now();
			let stopped = false;
			try {
				await docker.start(handle.name, handle.containerId);
				await startRunner(
					docker,
					handle.name,
					handle.containerId,
					job.encodedJitConfig,
				);
				for (;;) {
					if (job.signal.aborted || now() - startedMs > timeoutMs) {
						stopped = true;
						break;
					}
					if (
						await docker.exists(
							handle.name,
							handle.containerId,
							RUNNER_EXITED_PATH,
						)
					)
						break;
					if (!(await docker.isRunning(handle.name, handle.containerId))) break;
					await wait(options.pollMs ?? 2_000, job.signal);
				}
				const code = stopped
					? undefined
					: await docker.readContainerFile?.(
							handle.name,
							handle.containerId,
							RUNNER_EXIT_CODE_PATH,
							16,
						);
				const parsed =
					code === undefined ? Number.NaN : Number.parseInt(code, 10);
				return {
					exitCode: Number.isFinite(parsed) ? parsed : undefined,
					stopped,
				};
			} finally {
				await docker
					.stop(handle.name, handle.containerId)
					.catch(() => undefined);
				await docker
					.remove(handle.name, handle.containerId)
					.catch(() => undefined);
			}
		},
	};
}

export interface RunnerProgram {
	prepare(signal: AbortSignal): Promise<string>;
	discard(directory: string): Promise<void>;
}

export type HostProcess = (
	command: string,
	args: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	signal: AbortSignal,
) => Promise<number>;

export const nodeHostProcess: HostProcess = async (
	command,
	args,
	cwd,
	env,
	signal,
) => {
	try {
		await runHostProcess(command, [...args], cwd, env, undefined, signal);
		return 0;
	} catch {
		return 1;
	}
};

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function pinnedRunnerProgram(
	options: Readonly<{
		fetch: typeof fetch;
		cacheDir: string;
		arch: string;
		process: HostProcess;
		env: NodeJS.ProcessEnv;
	}>,
): RunnerProgram {
	const download = runnerDownloadFor(options.arch);
	const archive = join(
		options.cacheDir,
		`actions-runner-${options.arch}-${RUNNER_VERSION}.tar.gz`,
	);
	async function verifiedArchive(signal: AbortSignal): Promise<void> {
		const cached = await readFile(archive).catch(() => undefined);
		if (cached && sha256(cached) === download.sha256) return;
		const response = await options.fetch(download.url, { signal });
		if (!response.ok)
			throw new Error(`the runner download failed (HTTP ${response.status})`);
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (sha256(bytes) !== download.sha256)
			throw new Error("the runner archive does not match its pinned checksum");
		await mkdir(options.cacheDir, { recursive: true, mode: 0o700 });
		await writeFile(archive, bytes, { mode: 0o600 });
	}
	return {
		async prepare(signal) {
			await verifiedArchive(signal);
			const directory = await mkdtemp(join(options.cacheDir, "job-"));
			const exit = await options.process(
				"tar",
				["xzf", archive, "-C", directory],
				directory,
				runnerEnvironment(options.env),
				signal,
			);
			if (exit !== 0) {
				await rm(directory, { recursive: true, force: true });
				throw new Error("the runner archive could not be unpacked");
			}
			return directory;
		},
		discard: (directory) => rm(directory, { recursive: true, force: true }),
	};
}

export function hostExecutor(
	options: Readonly<{
		program: RunnerProgram;
		process: HostProcess;
		env: NodeJS.ProcessEnv;
	}>,
): JobExecutor {
	return {
		isolation: "host",
		async run(job) {
			const directory = await options.program.prepare(job.signal);
			try {
				const exitCode = await options.process(
					join(directory, "run.sh"),
					[],
					directory,
					hostJobEnvironment(options.env, job.encodedJitConfig),
					job.signal,
				);
				return { exitCode, stopped: job.signal.aborted };
			} finally {
				await options.program.discard(directory);
			}
		},
	};
}
