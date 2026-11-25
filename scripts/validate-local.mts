import { spawnSync } from "node:child_process";

import { commandForPlatform, sanitizeNodeOptions } from "./lib/env.ts";

const base = process.env.HOBO_CHECK_BASE ?? "HEAD~1";

function runPnpm(pnpmArgs: string[]): number {
	const { command, args } = commandForPlatform("pnpm", pnpmArgs);
	const result = spawnSync(command, args, {
		stdio: "inherit",
		shell: false,
		env: sanitizeNodeOptions(),
	});
	return result.status ?? 1;
}

let status = runPnpm(["run", "standards:check", "--", `--base=${base}`]);
if (status === 0) {
	status = runPnpm(["run", "test:changed"]);
}

process.exit(status);
