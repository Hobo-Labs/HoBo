import { spawnSync } from "node:child_process";
import { join } from "node:path";

const rootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], {
	encoding: "utf8",
});
if (rootResult.status !== 0) process.exit(rootResult.status ?? 1);
const root = rootResult.stdout.trim();
const modes = ["--worktree"];
const main = spawnSync(
	"git",
	["rev-parse", "--verify", "origin/main^{commit}"],
	{
		cwd: root,
		stdio: "ignore",
	},
);
if (main.status === 0) modes.push("--base=origin/main");
for (const mode of modes) {
	const result = spawnSync(
		process.execPath,
		["--import", "tsx", join(root, "scripts/check-source-policy.mts"), mode],
		{ cwd: root, stdio: "inherit" },
	);
	if (result.status !== 0) process.exit(result.status ?? 1);
}
