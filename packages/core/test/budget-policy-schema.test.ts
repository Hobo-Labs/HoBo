import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { JsonValue } from "../src/json.js";

const cue = fileURLToPath(
	new URL("../../../.tools/cue/v0.14.0/cue", import.meta.url),
);
const schema = fileURLToPath(
	new URL("../data-models/budget_policy.cue", import.meta.url),
);
const directory = mkdtempSync(join(tmpdir(), "hobo-budget-policy-cue-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
let sequence = 0;
const base = {
	schemaVersion: "hobo.budget-policy/v1",
	tenantId: "team",
	budgetId: "engineering",
	periodId: "period-1",
	revision: "r1",
	workloads: ["ci", "hosting"],
	currency: "USD",
	limitMicros: 0,
	objective: "min-cost",
	enforcement: "conservative",
	periodKind: "manual",
};
function check(document: JsonValue) {
	const path = join(directory, `${++sequence}.json`);
	writeFileSync(path, JSON.stringify(document));
	return spawnSync(
		cue,
		["vet", "-c", "-d", "#BudgetPolicyRecord", schema, path],
		{
			encoding: "utf8",
			timeout: 10_000,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
}
describe("actual shared budget policy CUE contract", () => {
	it.each([
		base,
		{ ...base, enforcement: "strict", objective: "maximize-credits" },
		{
			...base,
			periodKind: "fixed-window",
			periodStartsAtMs: 1000,
			periodEndsAtMs: 2000,
		},
		{
			...base,
			constraints: [
				{ key: "ci.attempts", workload: "ci", unit: "count", maximum: 2 },
			],
		},
	])("accepts explicit portable authored controls %#", (document) => {
		const result = check(document);
		expect(result.error).toBeUndefined();
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
	});
	it.each([
		{ ...base, limitMicros: -1 },
		{ ...base, limitMicros: 0.5 },
		{ ...base, limitMicros: 9007199254740992 },
		{ ...base, spentMicros: 0 },
		{ ...base, currency: "EUR" },
		{ ...base, enforcement: "optional" },
		{ ...base, periodKind: "fixed-window" },
		{
			...base,
			periodKind: "fixed-window",
			periodStartsAtMs: 2000,
			periodEndsAtMs: 1000,
		},
		{ ...base, periodEndsAtMs: 2000 },
		{
			...base,
			constraints: [{ key: "cost", workload: "ci", unit: "count", maximum: 2 }],
		},
	])("refuses incomplete or silently weakened policy %#", (document) => {
		const result = check(document);
		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
	});
});
