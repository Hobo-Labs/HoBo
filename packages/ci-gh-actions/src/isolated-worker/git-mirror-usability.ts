import { spawnSync } from "node:child_process";

export const INCOMPLETE_MIRROR_REASON =
	"mirror is a partial or promisor clone (blob:none)";

function readConfig(gitDir: string, key: string): string {
	const result = spawnSync(
		"git",
		[`--git-dir=${gitDir}`, "config", "--get", key],
		{ encoding: "utf8" },
	);
	return result.status === 0 ? result.stdout.trim() : "";
}

function readBoolConfig(gitDir: string, key: string): boolean {
	const result = spawnSync(
		"git",
		[`--git-dir=${gitDir}`, "config", "--bool", "--get", key],
		{ encoding: "utf8" },
	);
	return result.status === 0 && result.stdout.trim() === "true";
}

/** Bare mirrors used as upload-pack must not be promisor / blob:none partial clones. */
export function isCompleteGitMirror(gitDir: string): boolean {
	if (readBoolConfig(gitDir, "remote.origin.promisor")) return false;
	const partial = readConfig(gitDir, "extensions.partialclonefilter");
	return partial.length === 0;
}
