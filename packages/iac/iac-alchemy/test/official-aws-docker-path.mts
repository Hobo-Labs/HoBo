import { posix } from "node:path";

const { isAbsolute, join, relative, sep } = posix;

export const HOST_VISIBLE_JOB_MOUNT = "/opt/actions-runner/_hobo_work";

/**
 * Where the runner may unpack the emulator. Job containers keep `/tmp` on a
 * private tmpfs; the host-visible work mount and `RUNNER_TEMP` are on disk.
 */
export function emulatorScratchParent(
	env: Readonly<Record<string, string | undefined>>,
	tmp: string,
	mount = HOST_VISIBLE_JOB_MOUNT,
): string {
	if (env.HOBO_CI_HOST_JOB_DIRECTORY) return mount;
	return env.RUNNER_TEMP || tmp;
}

/**
 * Directories that may be the same path inside the runner and the Docker
 * daemon (ARC dind shares the work volume; a host daemon does not share
 * `/tmp`). The host job directory is the only candidate when it is set,
 * because other container paths are not that host path.
 */
export function emulatorBindCandidates(
	env: Readonly<Record<string, string | undefined>>,
	tmp: string,
	mount = HOST_VISIBLE_JOB_MOUNT,
): readonly string[] {
	if (env.HOBO_CI_HOST_JOB_DIRECTORY) return [mount];
	const ordered = [
		env.RUNNER_TEMP,
		"/home/runner/_work",
		"/opt/actions-runner/_work",
		env.GITHUB_WORKSPACE,
		tmp,
	];
	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const entry of ordered) {
		if (!entry || seen.has(entry)) continue;
		seen.add(entry);
		candidates.push(entry);
	}
	return candidates;
}

/** Daemon path for `file`, or undefined when a host job directory cannot see it. */
export function mountSourceFor(
	file: string,
	env: Readonly<Record<string, string | undefined>>,
	mount = HOST_VISIBLE_JOB_MOUNT,
): string | undefined {
	const hostJob = env.HOBO_CI_HOST_JOB_DIRECTORY;
	if (!hostJob) return file;
	const rel = relative(mount, file);
	if (
		rel === "" ||
		rel === ".." ||
		rel.startsWith(`..${sep}`) ||
		isAbsolute(rel)
	)
		return undefined;
	return join(hostJob, rel);
}

export function dockerBindSource(
	file: string,
	env: Readonly<Record<string, string | undefined>>,
	mount = HOST_VISIBLE_JOB_MOUNT,
): string {
	const source = mountSourceFor(file, env, mount);
	if (source === undefined)
		throw new Error(
			"AWS emulator file is outside the host-visible job directory",
		);
	return source;
}

export function isMissingBindSource(text: string): boolean {
	return text.includes("bind source path does not exist");
}

/** `docker run` args. Omit `bindSource` when the binary is already in `image`. */
export function emulatorRunArgs(input: {
	readonly name: string;
	readonly image: string;
	readonly bindSource?: string;
}): string[] {
	return [
		"run",
		"-d",
		"--rm",
		"--name",
		input.name,
		"--read-only",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--tmpfs",
		"/root:rw,noexec,nosuid,size=128m",
		"--tmpfs",
		"/tmp:rw,noexec,nosuid,size=128m",
		...(input.bindSource
			? [
					"--mount",
					`type=bind,src=${input.bindSource},dst=/usr/local/bin/aws-emulator,readonly`,
				]
			: []),
		"--publish",
		"127.0.0.1::9297",
		input.image,
		"/usr/local/bin/aws-emulator",
		"--bind",
		"0.0.0.0",
		"--port",
		"9297",
		"--auth",
		"off",
		"--telemetry",
		"off",
		"--idle-timeout",
		"900",
	];
}
