/**
 * Vitest globalSetup: point this package's tests at a temporary directory on
 * tmpfs, and remove it when the run ends.
 *
 * The tests open a fresh on-disk SqliteCiStore per case (WAL, default
 * synchronous mode), so every commit waits on an fsync; on a disk that is most
 * of github-job-poller's and isolated-worker-deps-image's time. tmpfs answers
 * an fsync at once. Production durability is untouched: only TMPDIR, read by
 * the tests' own `tmpdir()`, moves.
 *
 * It applies only where /dev/shm is a directory with room to spare and allows
 * running a file: tests write fake `docker` and runner scripts under TMPDIR
 * and run them, which a `noexec` mount refuses. Otherwise the disk is kept, as
 * before (a container whose /dev/shm is Docker's 64 MiB default, or mounted
 * noexec). HOBO_CI_TEST_TMPFS=0 keeps it too.
 */
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	rmSync,
	statfsSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const SHM = "/dev/shm";
/** Room enough that a tmpfs shared with other jobs does not fill under the tests. */
const MIN_FREE_BYTES = 512 * 1024 * 1024;

function roomOnTmpfs(): boolean {
	try {
		const stats = statfsSync(SHM);
		return stats.bavail * stats.bsize >= MIN_FREE_BYTES;
	} catch {
		return false;
	}
}

/** Whether a script written into `directory` can be run from there. */
function runsFrom(directory: string): boolean {
	try {
		const probe = join(directory, "exec-probe");
		writeFileSync(probe, "#!/bin/sh\nexit 0\n");
		chmodSync(probe, 0o755);
		const result = spawnSync(probe, { stdio: "ignore" });
		rmSync(probe, { force: true });
		return result.error === undefined && result.status === 0;
	} catch {
		return false;
	}
}

export default function setup(): (() => void) | undefined {
	if (process.env.HOBO_CI_TEST_TMPFS === "0" || !roomOnTmpfs()) return;
	let directory: string;
	try {
		directory = mkdtempSync(join(SHM, "hobo-ci-gh-actions-test-"));
	} catch {
		return;
	}
	if (!runsFrom(directory)) {
		rmSync(directory, { recursive: true, force: true });
		return;
	}
	const previous = process.env.TMPDIR;
	process.env.TMPDIR = directory;
	return () => {
		if (previous === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previous;
		rmSync(directory, { recursive: true, force: true });
	};
}
