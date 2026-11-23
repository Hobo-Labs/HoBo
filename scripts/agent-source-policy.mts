import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = spawnSync("git", ["rev-parse", "--show-toplevel"], {
	encoding: "utf8",
	stdio: ["ignore", "pipe", "pipe"],
});

if (repository.status !== 0 || !repository.stdout.trim()) {
	process.stderr.write("Source policy could not locate the repository.\n");
	process.exitCode = 2;
} else {
	const root = repository.stdout.trim();
	const guard = fileURLToPath(
		new URL("./check-source-policy.mts", import.meta.url),
	);
	const modes = ["--worktree"];
	const main = spawnSync(
		"git",
		["rev-parse", "--verify", "origin/main^{commit}"],
		{ cwd: root, stdio: "ignore" },
	);
	if (main.status === 0) modes.push("--base=origin/main");
	for (const mode of modes) {
		const result = spawnSync(
			process.execPath,
			["--import", import.meta.resolve("tsx"), guard, mode],
			{
				cwd: root,
				encoding: "utf8",
				env: { ...process.env, NODE_OPTIONS: "" },
				maxBuffer: 4 * 1024 * 1024,
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 45_000,
			},
		);
		if (result.status !== 0) {
			process.stderr.write(
				"Source policy requires self-documenting code and completed work.\n",
			);
			process.stderr.write(
				result.stderr ||
					result.error?.message ||
					`Guard exited ${result.status}.\n`,
			);
			process.exitCode = 2;
			break;
		}
	}
}
