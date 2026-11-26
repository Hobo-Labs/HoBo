#!/usr/bin/env node
import path from "node:path";

import {
	CiFabricContractError,
	createHoboCiFabricContract,
} from "../src/contract.js";
import { parseJsonTree } from "../src/json.js";
import { parseCiFabricContract } from "../src/parse.js";
import { assertCiFabricContract } from "../src/validate.js";
import { loadWorkflowFiles } from "../src/workflows.js";

async function main(): Promise<void> {
	const repoRoot = process.cwd();
	const workflowsDir = path.join(repoRoot, ".github", "workflows");
	const workflows = await loadWorkflowFiles(workflowsDir);
	const raw = parseJsonTree(JSON.stringify(createHoboCiFabricContract()));
	const contract = parseCiFabricContract(raw);
	const report = assertCiFabricContract(contract, workflows);
	console.log(JSON.stringify({ ok: true, coverage: report.coverage }, null, 2));
}

main().catch((error) => {
	const code =
		error instanceof CiFabricContractError
			? error.code
			: "ci-fabric-contract-failed";
	const message = error instanceof Error ? error.message : String(error);
	console.error(JSON.stringify({ ok: false, code, message }, null, 2));
	process.exitCode = 1;
});
