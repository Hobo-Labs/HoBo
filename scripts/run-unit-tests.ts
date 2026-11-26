import { spawnSync } from "node:child_process";

import { commandForPlatform, sanitizeNodeOptions } from "./lib/env.ts";
import { turboConcurrencyArg } from "./lib/turbo-concurrency.ts";
import { unitTestCoverageProblems } from "./lib/unit-test-coverage.ts";
import { rootUnitTaskNames } from "./lib/unit-test-selection.ts";

const coverageProblems = unitTestCoverageProblems();
if (coverageProblems.length > 0) {
	throw new Error(
		`unit test coverage mismatch:\n${coverageProblems.join("\n")}`,
	);
}

const quiet = process.argv.includes("--quiet");
const invocation = commandForPlatform("pnpm", [
	"exec",
	"turbo",
	"run",
	...rootUnitTaskNames,
	turboConcurrencyArg(),
	quiet ? "--output-logs=errors-only" : "--output-logs=new-only",
]);
const result = spawnSync(invocation.command, invocation.args, {
	stdio: "inherit",
	shell: false,
	env: sanitizeNodeOptions(),
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
