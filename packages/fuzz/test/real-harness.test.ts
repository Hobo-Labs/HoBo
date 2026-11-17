import {
	createDecision,
	createDecisionRequest,
	POLICY_IR_SCHEMA_VERSION,
} from "@hobo/policy";
import { expect, it } from "vitest";
import { fuzzEventEnvelope, fuzzPolicyDocument } from "../src/harness.js";
import type { FuzzValue } from "../src/manifest.js";

const bytes = (value: FuzzValue) => Buffer.from(JSON.stringify(value));
const envelope = {
	id: "event-1",
	type: "demo.Created",
	v: 1,
	streamId: "demo:1",
	seq: 1,
	ts: "2026-01-01T00:00:00.000Z",
	actor: { kind: "agent", id: "agent-a" },
	tenant: "tenant-a",
	data: { ok: true },
};

it("exercises the real event-envelope parser on valid and invalid input", () => {
	expect(fuzzEventEnvelope(bytes(envelope))).toBe("accepted");
	expect(fuzzEventEnvelope(bytes({ ...envelope, seq: -1 }))).toBe("rejected");
	expect(fuzzEventEnvelope(Buffer.from("not-json"))).toBe("invalid-json");
});

it("exercises and round-trips real policy decisions", () => {
	const request = createDecisionRequest({
		schemaVersion: POLICY_IR_SCHEMA_VERSION,
		subject: { kind: "agent", id: "a" },
		action: "deploy",
		resource: { kind: "service", id: "api" },
		phase: "apply",
	});
	const decision = createDecision(request, {
		effect: "allow",
		reason: "scoped",
		evidence: { policyIds: [], engine: "test-engine" },
	});
	expect(fuzzPolicyDocument(bytes({ request, decision }))).toBe("accepted");
	expect(
		fuzzPolicyDocument(
			bytes({
				request,
				decision: {
					...decision,
					evidence: {
						...decision.evidence,
						inputHash: `sha256:${"0".repeat(64)}`,
					},
				},
			}),
		),
	).toBe("rejected");
});

it("keeps prototype-named data inert during event and policy replay", () => {
	const data = JSON.parse(
		'{"__proto__":{"spoofed":true},"constructor":"literal"}',
	);
	expect(fuzzEventEnvelope(bytes({ ...envelope, data }))).toBe("accepted");
	const request = createDecisionRequest({
		schemaVersion: POLICY_IR_SCHEMA_VERSION,
		subject: { kind: "agent", id: "a" },
		action: "deploy",
		resource: { kind: "service", id: "api" },
		phase: "apply",
		context: data,
	});
	const decision = createDecision(request, {
		effect: "deny",
		reason: "blocked",
		evidence: { policyIds: [], engine: "test-engine" },
	});
	expect(fuzzPolicyDocument(bytes({ request, decision }))).toBe("accepted");
	expect(Object.hasOwn(Object.prototype, "spoofed")).toBe(false);
});
