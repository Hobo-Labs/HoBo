import {
	fromWitDecisionRecord,
	fromWitDecisionRecordV2,
	parseDecision,
	toWitDecisionRecord,
	toWitDecisionRecordV2,
} from "@hobo/policy";
import { expect, it } from "vitest";
import { evaluatePolicyPack, type PolicyRule } from "../src/policy-pack.js";

const request = {
	subject: { kind: "agent", id: "agent-a" },
	action: "object.delete",
	resource: { kind: "bucket", id: "prod" },
	phase: "apply",
};
const allow: PolicyRule = {
	id: "allow",
	when: () => true,
	decide: () => ({ effect: "allow", reason: "allowed" }),
};

it("records the exact policy pack version through event replay and WIT conversion", () => {
	const result = evaluatePolicyPack({
		request,
		pack: { id: "mandatory/prod", version: "2.3.1", rules: [allow] },
	});
	expect(result.decision.evidence).toMatchObject({
		packId: "mandatory/prod",
		packVersion: "2.3.1",
	});
	const replayed = parseDecision(JSON.parse(JSON.stringify(result.event.data)));
	expect(replayed.evidence).toMatchObject({
		packId: "mandatory/prod",
		packVersion: "2.3.1",
	});
	const record = toWitDecisionRecordV2(replayed);
	expect(record.evidence).toMatchObject({
		packId: "mandatory/prod",
		packVersion: "2.3.1",
	});
	expect(fromWitDecisionRecordV2(record).evidence).toEqual(replayed.evidence);
});

it("continues to read older decisions without pack metadata", () => {
	const result = evaluatePolicyPack({ request });
	const evidence = {
		policyIds: result.decision.evidence.policyIds,
		inputHash: result.decision.evidence.inputHash,
		engine: result.decision.evidence.engine,
	};
	const old = { ...result.decision, evidence };
	expect(parseDecision(old).evidence).toEqual(evidence);
	expect(fromWitDecisionRecord(toWitDecisionRecord(old)).evidence).toEqual(
		evidence,
	);
	expect(fromWitDecisionRecordV2(toWitDecisionRecordV2(old)).evidence).toEqual(
		evidence,
	);
});

it("round-trips structured policy data through the versioned WIT record", () => {
	const result = evaluatePolicyPack({
		request,
		pack: { id: "mandatory/prod", version: "2.3.1", rules: [allow] },
	});
	const original = parseDecision({
		...result.decision,
		violations: ["one", { field: "value" }],
		mutations: [{ nested: [1, 2] }],
		approvals: [{ by: "reviewer" }],
		obligations: [{ kind: "notify", target: "owner" }],
	});
	const record = toWitDecisionRecordV2(original);
	expect(fromWitDecisionRecordV2(record)).toEqual(original);
	expect(() =>
		fromWitDecisionRecordV2({ ...record, mutationsJson: "{private input" }),
	).toThrow("expected JSON array");
	expect(() =>
		fromWitDecisionRecordV2({ ...record, approvalsJson: "{}" }),
	).toThrow("expected-array");
});

it.each([
	["missing pack version", { packId: "mandatory/prod" }],
	["missing pack ID", { packVersion: "2.3.1" }],
	["empty pack ID", { packId: "", packVersion: "2.3.1" }],
	["empty pack version", { packId: "mandatory/prod", packVersion: "" }],
])("rejects evidence with %s", (_name, partial) => {
	const result = evaluatePolicyPack({ request });
	const { policyIds, inputHash, engine } = result.decision.evidence;
	expect(() =>
		parseDecision({
			...result.decision,
			evidence: {
				policyIds,
				inputHash,
				engine,
				...partial,
			},
		}),
	).toThrow();
});

it.each([
	[
		"throwing predicate",
		{
			id: "broken",
			when: () => {
				throw new Error("private-detail");
			},
			decide: () => ({ effect: "deny", reason: "unreachable" }),
		},
	],
	[
		"invalid predicate",
		{
			id: "broken",
			when: () => JSON.parse('"yes"'),
			decide: () => ({ effect: "deny", reason: "unreachable" }),
		},
	],
	[
		"throwing decision",
		{
			id: "broken",
			when: () => true,
			decide: () => {
				throw new Error("private-detail");
			},
		},
	],
	[
		"invalid effect",
		{
			id: "broken",
			when: () => true,
			decide: () => ({ effect: JSON.parse('"unknown"'), reason: "invalid" }),
		},
	],
	[
		"invalid obligation",
		{
			id: "broken",
			when: () => true,
			decide: () => ({
				effect: "allow",
				reason: "invalid",
				obligations: [{ other: "missing kind" }],
			}),
		},
	],
	[
		"invalid violations",
		{
			id: "broken",
			when: () => true,
			decide: () => ({
				effect: "allow",
				reason: "invalid",
				violations: JSON.parse('[{"private":"detail"}]'),
			}),
		},
	],
])("fails closed and records an event for a %s", (_name, broken) => {
	const result = evaluatePolicyPack({
		request,
		pack: { id: "mandatory/prod", version: "2.3.1", rules: [broken, allow] },
	});
	expect(result.decision.effect).toBe("deny");
	expect(result.event.type).toBe("policy.Decided");
	expect(result.event.data.effect).toBe("deny");
	expect(result.matchedRuleIds).toContain("broken");
	expect(JSON.stringify(result)).not.toContain("private-detail");
});
