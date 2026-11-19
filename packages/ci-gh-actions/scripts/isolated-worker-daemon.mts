#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const REBUILD = "pnpm exec turbo run build --filter=@hobo/ci-gh-actions";

function fail(message: string): never {
	console.error(
		JSON.stringify({ event: "hobo_ci_isolated_worker_start_failed", message }),
	);
	process.exit(1);
}

if (process.env.HOBO_CI_WORKER_BUILD !== "0" && !process.env.TURBO_HASH) {
	const build = spawnSync(
		"pnpm",
		[
			"exec",
			"turbo",
			"run",
			"build",
			"--filter=@hobo/ci-gh-actions",
			"--output-logs=errors-only",
			"--concurrency=100%",
		],
		{ cwd: packageRoot, stdio: ["ignore", "inherit", "inherit"] },
	);
	if (build.error)
		fail(
			`cannot build @hobo/ci-gh-actions and its dependencies (${build.error.message}); put pnpm on PATH, or build them and set HOBO_CI_WORKER_BUILD=0`,
		);
	if (build.status !== 0)
		fail(
			`building @hobo/ci-gh-actions and its dependencies failed (exit ${build.status ?? build.signal}); the daemon was not started`,
		);
}

try {
	await import("./isolated-worker-daemon-main.mts");
} catch (error) {
	if (
		error instanceof SyntaxError &&
		/does not provide an export named/u.test(error.message)
	)
		fail(`stale build (${error.message}); run ${REBUILD}`);
	throw error;
}
