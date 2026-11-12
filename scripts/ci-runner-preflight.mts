#!/usr/bin/env node
import {
	assertPinnedMiseToolchain,
	evaluateCiRunnerContract,
	formatContractFailure,
	syncMissingMiseTools,
} from "./lib/ci-runner-contract.mts";

const verifyOnly = process.env.HOBO_CI_PREFLIGHT_SKIP_MISE_INSTALL === "1";
const sync = verifyOnly
	? assertPinnedMiseToolchain(process.cwd())
	: syncMissingMiseTools(process.cwd());
console.log(
	`${sync.ok ? "ok  " : "ERR "} mise-tool-sync: ${sync.detail} (${sync.elapsedMs} ms)`,
);
if (!sync.ok) process.exit(1);

const checks = evaluateCiRunnerContract(process.cwd());
for (const c of checks) {
	console.log(`${c.ok ? "ok  " : "ERR "} ${c.name}: ${c.detail}`);
}
const failed = checks.filter((c) => !c.ok);
if (failed.length > 0) {
	console.error("\n" + formatContractFailure(checks));
	process.exit(1);
}
console.log("CI runner preflight passed.");
