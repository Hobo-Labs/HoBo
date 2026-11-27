import { posix } from "node:path";

const { isAbsolute, join, relative, sep } = posix;

/** Container path of the host job directory bind mount. */
export const HOST_VISIBLE_JOB_MOUNT = "/opt/actions-runner/_hobo_work";

/**
 * Directory the runner can use for files the host Docker daemon must see.
 * Job containers mount the host socket and keep `/tmp` on a private tmpfs.
 */
export function emulatorScratchParent(
	env: Readonly<Record<string, string | undefined>>,
	tmp: string,
	mount = HOST_VISIBLE_JOB_MOUNT,
): string {
	const hostJob = env.HOBO_CI_HOST_JOB_DIRECTORY;
	return hostJob ? mount : tmp;
}

/** Bind-mount source for `file`, translated onto the host job directory. */
export function dockerBindSource(
	file: string,
	env: Readonly<Record<string, string | undefined>>,
	mount = HOST_VISIBLE_JOB_MOUNT,
): string {
	const hostJob = env.HOBO_CI_HOST_JOB_DIRECTORY;
	if (!hostJob) return file;
	const rel = relative(mount, file);
	if (
		rel === "" ||
		rel === ".." ||
		rel.startsWith(`..${sep}`) ||
		isAbsolute(rel)
	)
		throw new Error(
			"AWS emulator file is outside the host-visible job directory",
		);
	return join(hostJob, rel);
}
