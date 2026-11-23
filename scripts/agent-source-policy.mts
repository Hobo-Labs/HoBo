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
	const sourceModes = ["--worktree"];
	const main = spawnSync(
		"git",
		["rev-parse", "--verify", "origin/main^{commit}"],
		{ cwd: root, stdio: "ignore" },
	);
	if (main.status === 0) sourceModes.push("--base=origin/main");
	const guards = [
		{
			script: "./check-source-policy.mts",
			loader: ["--import", import.meta.resolve("tsx")],
			heading:
				"Source policy requires self-documenting code and completed work.\n",
			modes: sourceModes,
		},
		{
			script: "./check-secret-storage.mts",
			loader: ["--experimental-strip-types"],
			heading: "Secret policy: agents never store secrets.\n",
			modes: ["--worktree"],
		},
	];
	for (const guard of guards) {
		for (const mode of guard.modes) {
			const result = spawnSync(
				process.execPath,
				[
					...guard.loader,
					fileURLToPath(new URL(guard.script, import.meta.url)),
					mode,
				],
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
				process.stderr.write(guard.heading);
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
}
