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
 * It applies only where /dev/shm is a directory with room to spare. A container
 * whose /dev/shm is Docker's 64 MiB default keeps the disk, as before.
 * HOBO_CI_TEST_TMPFS=0 keeps it too.
 */
import { mkdtempSync, rmSync, statfsSync } from "node:fs";
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

export default function setup(): (() => void) | undefined {
	if (process.env.HOBO_CI_TEST_TMPFS === "0" || !roomOnTmpfs()) return;
	const previous = process.env.TMPDIR;
	const directory = mkdtempSync(join(SHM, "hobo-ci-gh-actions-test-"));
	process.env.TMPDIR = directory;
	return () => {
		if (previous === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previous;
		rmSync(directory, { recursive: true, force: true });
	};
}
