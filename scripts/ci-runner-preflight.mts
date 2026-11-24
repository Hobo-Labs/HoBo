#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
	evaluateCiRunnerContract,
	formatContractFailure,
	JOB_SCOPED_MISE_TOOLS,
	JOB_TOOLS_ENV,
	jobMiseTools,
	MISE_TOML,
	parseMiseToolNames,
	syncMissingMiseTools,
	unknownJobTools,
} from "./lib/ci-runner-contract.mts";

const unknown = unknownJobTools();
if (unknown.length > 0) {
	console.error(
		`ERR  ${JOB_TOOLS_ENV}: ${unknown.join(", ")} not job-scoped; name only ${JOB_SCOPED_MISE_TOOLS.join(", ")} (or all)`,
	);
	process.exit(1);
}
if (process.argv.includes("--print-job-tools")) {
	for (const tool of jobMiseTools(
		parseMiseToolNames(readFileSync(MISE_TOML, "utf8")),
	)) {
		console.log(tool);
	}
	process.exit(0);
}

const sync = syncMissingMiseTools(process.cwd());
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
