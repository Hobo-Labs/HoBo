import {
	CI_FABRIC_SCHEMA,
	type CiFabricContract,
	CiFabricContractError,
	REQUIRED_PR_CHECKS,
	type RequiredPrCheck,
} from "./contract.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./json.js";

export type { JsonObject, JsonValue } from "./json.js";
export {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	parseJsonTree,
} from "./json.js";

function requiredPrCheck(value: JsonValue): RequiredPrCheck | undefined {
	for (const check of REQUIRED_PR_CHECKS) {
		if (value === check) {
			return check;
		}
	}
	return undefined;
}

function parseRequiredChecks(
	value: JsonValue | undefined,
): readonly RequiredPrCheck[] {
	if (!Array.isArray(value)) {
		throw new CiFabricContractError(
			"parse.required-checks",
			"pullRequestGate.requiredChecks must be an array",
		);
	}
	const checks: RequiredPrCheck[] = [];
	for (const item of value) {
		const check = requiredPrCheck(item);
		if (check === undefined) {
			throw new CiFabricContractError(
				"parse.required-checks",
				`invalid required check: ${String(item)}`,
			);
		}
		checks.push(check);
	}
	return checks;
}

export function parseCiFabricContract(
	input: JsonValue | undefined,
): CiFabricContract {
	if (!isJsonObject(input)) {
		throw new CiFabricContractError("parse.root", "contract must be an object");
	}

	if (input.schema !== CI_FABRIC_SCHEMA) {
		throw new CiFabricContractError(
			"parse.schema",
			`expected schema ${CI_FABRIC_SCHEMA}`,
			{ schema: input.schema ?? null },
		);
	}

	const workflow = input.workflow;
	if (!isJsonObject(workflow)) {
		throw new CiFabricContractError(
			"parse.workflow",
			"workflow must be an object",
		);
	}

	const pullRequestGate = workflow.pullRequestGate;
	if (!isJsonObject(pullRequestGate)) {
		throw new CiFabricContractError(
			"parse.pull-request-gate",
			"workflow.pullRequestGate must be an object",
		);
	}

	if (pullRequestGate.blocksPullRequest !== true) {
		throw new CiFabricContractError(
			"parse.pull-request-gate",
			"workflow.pullRequestGate.blocksPullRequest must be true",
		);
	}

	const _requiredChecks = parseRequiredChecks(pullRequestGate.requiredChecks);
	void _requiredChecks;

	const e2e = input.e2e;
	if (!isJsonObject(e2e)) {
		throw new CiFabricContractError("parse.e2e", "e2e must be an object");
	}

	const auth = e2e.auth;
	if (!isJsonObject(auth)) {
		throw new CiFabricContractError(
			"parse.e2e.auth",
			"e2e.auth must be an object",
		);
	}

	if (auth.mode !== "oidc-federation") {
		throw new CiFabricContractError(
			"parse.e2e.auth.mode",
			'e2e.auth.mode must be "oidc-federation"',
		);
	}

	if (auth.forbidsStoredSecrets !== true) {
		throw new CiFabricContractError(
			"parse.e2e.auth.forbids-stored-secrets",
			"e2e.auth.forbidsStoredSecrets must be true",
		);
	}

	const teardown = e2e.teardown;
	if (!isJsonObject(teardown)) {
		throw new CiFabricContractError(
			"parse.e2e.teardown",
			"e2e.teardown must be an object",
		);
	}

	if (teardown.always !== true) {
		throw new CiFabricContractError(
			"parse.e2e.teardown.always",
			"e2e.teardown.always must be true",
		);
	}

	const orphanSweeper = teardown.orphanSweeper;
	if (!isJsonObject(orphanSweeper) || orphanSweeper.enabled !== true) {
		throw new CiFabricContractError(
			"parse.e2e.teardown.orphan-sweeper",
			"e2e.teardown.orphanSweeper.enabled must be true",
		);
	}

	const quarantine = e2e.quarantine;
	if (!isJsonObject(quarantine)) {
		throw new CiFabricContractError(
			"parse.e2e.quarantine",
			"e2e.quarantine must be an object",
		);
	}

	if (
		quarantine.continueOnError !== true ||
		quarantine.blocksPullRequest !== false
	) {
		throw new CiFabricContractError(
			"parse.e2e.quarantine",
			"e2e.quarantine must be non-blocking",
		);
	}

	const gatedBy = e2e.gatedBy;
	if (!Array.isArray(gatedBy) || gatedBy.length === 0) {
		throw new CiFabricContractError(
			"parse.e2e.gated-by",
			"e2e.gatedBy must be non-empty",
		);
	}

	markParsedContract(input);
	return input;
}

function markParsedContract(
	input: JsonObject,
): asserts input is CiFabricContract & JsonObject {
	void input;
}
