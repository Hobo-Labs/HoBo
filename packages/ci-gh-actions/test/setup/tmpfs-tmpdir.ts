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
const MIN_FREE_BYTES = 512 * 1024 * 1024;

function roomOnTmpfs(): boolean {
	try {
		const stats = statfsSync(SHM);
		return stats.bavail * stats.bsize >= MIN_FREE_BYTES;
	} catch {
		return false;
	}
}

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
