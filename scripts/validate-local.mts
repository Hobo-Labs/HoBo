// `validate:local` lane: refresh technical-standards evidence against the base
// ref, then run the changed-test lane. Replaces an `sh -c` one-liner so it
// works in Windows shells too. The base defaults to HEAD~1 and honors
// HOBO_CHECK_BASE (which the delegated `test:changed` lane reads as well).
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
