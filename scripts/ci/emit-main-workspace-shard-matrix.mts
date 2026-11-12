/**
 * Emit main workspace `shard_matrix` after planning (fresh `vars` snapshot).
 * Install-free on the worker — builtins + load-fleet-capacity only.
 */
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
	fetchFleetCapacityVariable,
	mainGateShardCountFromIndexesJson,
	resolveMainWorkspaceShardRunners,
} from "./load-fleet-capacity.mts";

const GITHUB_OUTPUT = process.env.GITHUB_OUTPUT?.trim();

function setOutput(name: string, value: string): void {
	if (GITHUB_OUTPUT) {
		appendFileSync(GITHUB_OUTPUT, `${name}=${value}\n`);
		return;
	}
	console.log(`${name}=${value}`);
}

async function main(): Promise<void> {
	const repository = process.env.GITHUB_REPOSITORY ?? "";
	const token = process.env.GITHUB_TOKEN?.trim() ?? "";
	const raw = process.env.MAIN_GATE_SHARDS?.trim() ?? "[]";
	const count = mainGateShardCountFromIndexesJson(raw);
	if (count < 0) {
		console.error(`main gate shard matrix: malformed MAIN_GATE_SHARDS=${raw}`);
		process.exitCode = 1;
		return;
	}
	const fleet = await fetchFleetCapacityVariable({ repository, token });
	const matrix = resolveMainWorkspaceShardRunners(count, fleet, Date.now());
	setOutput("shard_matrix", JSON.stringify(matrix));
	console.error(
		`main gate shard matrix: shards=${count}, runners=${matrix.map((row) => row.runner).join(",") || "(none)"}`,
	);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	void main();
}
