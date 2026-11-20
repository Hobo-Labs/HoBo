import { spawnSync } from "node:child_process";

if (!process.env.TURBO_HASH) {
	const result = spawnSync(
		"pnpm",
		[
			"exec",
			"turbo",
			"run",
			"build",
			"--filter=@hobo/broker",
			"--filter=@hobo/dispatcher",
			"--filter=@hobo/pricing",
		],
		{ stdio: "inherit", shell: false },
	);
	process.exit(result.status ?? 1);
}
