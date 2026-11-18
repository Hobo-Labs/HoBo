import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createSweWorkspace() {
	const directory = mkdtempSync(join(tmpdir(), "hobo-swe-workspace-"));
	execFileSync("git", ["init", "--quiet", directory]);
	execFileSync("git", [
		"-C",
		directory,
		"-c",
		"user.name=fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"-c",
		`core.hooksPath=${join(directory, "no-hooks")}`,
		"commit",
		"--allow-empty",
		"--quiet",
		"-m",
		"fixture",
	]);
	return {
		directory,
		cleanup: () => rmSync(directory, { recursive: true, force: true }),
	};
}
