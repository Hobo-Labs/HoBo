#!/usr/bin/env node
/**
 * Box worker entry. The daemon imports `@hobo/ci-gh-actions` and `@hobo/ci`
 * from their `dist`, so a checkout pulled without a rebuild starts it against
 * stale exports. This builds them first through turbo (cached, so a warm start
 * costs about a second) and refuses to start when that fails.
 * `HOBO_CI_WORKER_BUILD=0` skips the build for a host that builds elsewhere;
 * a stale `dist` is then still reported as such rather than as a bare import
 * error. The daemon itself is `isolated-worker-daemon-main.mts`.
 */
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

// Inside a turbo task the build already ran (tasks.test dependsOn build).
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
