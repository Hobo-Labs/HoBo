import assert from "node:assert/strict";
import { test } from "vitest";

import {
	CONTROL_EVIDENCE_PACK_SCHEMA,
	CONTROL_EVIDENCE_REGISTRY,
	evaluateControlCoverage,
	NIST_800_53_SEED_PACK,
	parseControlEvidencePack,
	resolveControlEvidenceRef,
} from "../src/control-evidence-pack.js";
import {
	POLICY_IR_SCHEMA_VERSION,
	parseDecisionRequest,
} from "../src/policy-ir.js";
import { evaluateResidencyPolicy } from "../src/residency-policy-pack.js";
import { GDPR_SEED_PACK, SOC2_SEED_PACK } from "../src/seed-packs.js";

test("eu-data-stays-in-eu: pii landing in us-east-1 is denied with the rule named", () => {
	const decision = evaluateResidencyPolicy({
		classification: "pii",
		verdict: {
			ok: false,
			code: "jurisdiction-not-allowed",
			region: "us-east-1",
			regionJurisdictions: ["us"],
			remediation:
				"region us-east-1 (us) is outside allowed jurisdictions [eu, eea]",
		},
	});
	assert.equal(decision.allowed, false);
	assert.equal(decision.effect, "deny");
	assert.match(decision.reasons[0] ?? "", /'pii' data would land outside/u);
});

test("unregulated data in a mapped-but-disallowed region warns instead of denying", () => {
	const decision = evaluateResidencyPolicy({
		classification: "internal",
		verdict: {
			ok: false,
			code: "jurisdiction-not-allowed",
			region: "us-east-1",
			regionJurisdictions: ["us"],
		},
	});
	assert.equal(decision.allowed, true);
	assert.equal(decision.effect, "warn");
});

test("unmapped regions deny even for unregulated data (fail closed)", () => {
	const decision = evaluateResidencyPolicy({
		classification: "public",
		verdict: {
			ok: false,
			code: "region-unmapped",
			region: "mars-north-1",
			regionJurisdictions: [],
		},
	});
	assert.equal(decision.allowed, false);
});

test("a clean verdict allows and carries residency evidence obligations", () => {
	const decision = evaluateResidencyPolicy({
		classification: "phi",
		verdict: {
			ok: true,
			region: "eu-west-1",
			regionJurisdictions: ["eu", "eea"],
		},
	});
	assert.equal(decision.effect, "allow");
	const obligation = decision.obligations[0] as {
		kind: string;
		jurisdictions: string[];
	};
	assert.equal(obligation.kind, "residency-evidence");
	assert.deepEqual(obligation.jurisdictions, ["eu", "eea"]);
});

test("control-evidence pack parses fail closed", () => {
	assert.throws(
		() => parseControlEvidencePack({ schema: "wrong" }),
		/schema must be/u,
	);
	assert.throws(
		() =>
			parseControlEvidencePack({
				schema: CONTROL_EVIDENCE_PACK_SCHEMA,
				framework: "X",
				version: "1",
				controls: [
					{ controlId: "A", title: "a", status: "implemented", evidence: [] },
				],
			}),
		/at least one evidence ref/u,
	);
	assert.throws(
		() =>
			parseControlEvidencePack({
				schema: CONTROL_EVIDENCE_PACK_SCHEMA,
				framework: "X",
				version: "1",
				controls: [
					{
						controlId: "A",
						title: "a",
						status: "implemented",
						evidence: [{ kind: "artifact", ref: "artifact:invented" }],
					},
				],
			}),
		/not registered/u,
	);
});

const REGISTERED_EVIDENCE = Object.values(CONTROL_EVIDENCE_REGISTRY).map(
	(entry) => entry.ref,
);

test("the evidence registry binds every canonical ref to an owner and source", () => {
	for (const entry of Object.values(CONTROL_EVIDENCE_REGISTRY)) {
		assert.equal(resolveControlEvidenceRef(entry.ref), entry);
		assert.notEqual(entry.owner, "");
		assert.notEqual(entry.binding, "");
	}
	assert.equal(resolveControlEvidenceRef("artifact:invented"), undefined);
});

test("coverage: the NIST seed pack resolves completely", () => {
	const report = evaluateControlCoverage(
		NIST_800_53_SEED_PACK,
		REGISTERED_EVIDENCE,
	);
	assert.equal(report.total, 9);
	assert.equal(report.satisfied, 9);
	assert.deepEqual(report.missing, []);
});

test("coverage: missing evidence is named per control", () => {
	const report = evaluateControlCoverage(NIST_800_53_SEED_PACK, [
		"event-stream:policy.Decided",
	]);
	const ac3 = report.missing.find((entry) => entry.controlId === "AC-3");
	assert.ok(ac3);
	assert.deepEqual(ac3.missingRefs, ["gate:gatekeeper"]);
	assert.ok(report.coverage < 0.2);
});

test("SOC 2 seed pack resolves completely", () => {
	const report = evaluateControlCoverage(SOC2_SEED_PACK, REGISTERED_EVIDENCE);
	assert.equal(report.framework, "SOC 2 Trust Services Criteria");
	assert.equal(report.total, 8);
	assert.equal(report.satisfied, 8);
	assert.deepEqual(report.missing, []);
});

test("GDPR seed pack resolves completely", () => {
	const report = evaluateControlCoverage(GDPR_SEED_PACK, REGISTERED_EVIDENCE);
	assert.equal(report.total, 7);
	assert.equal(report.satisfied, 7);
	assert.deepEqual(report.missing, []);
});

test("coverage rejects caller-invented evidence refs", () => {
	assert.throws(
		() => evaluateControlCoverage(NIST_800_53_SEED_PACK, ["artifact:invented"]),
		/not registered/u,
	);
});

test("seed packs parsed at module load are frozen and schema-pinned", () => {
	for (const pack of [SOC2_SEED_PACK, GDPR_SEED_PACK]) {
		assert.equal(pack.schema, CONTROL_EVIDENCE_PACK_SCHEMA);
		assert.ok(Object.isFrozen(pack));
		assert.ok(Object.isFrozen(pack.controls));
	}
});

test("policy IR types context.dataClassifications (ADR-0146)", () => {
	const base = {
		schemaVersion: POLICY_IR_SCHEMA_VERSION,
		subject: { kind: "user", id: "u1" },
		action: "deploy",
		resource: { kind: "bindle", id: "b1" },
		phase: "plan",
	};
	const ok = parseDecisionRequest({
		...base,
		context: { dataClassifications: ["pii", "phi"] },
	});
	assert.deepEqual(ok.context, { dataClassifications: ["pii", "phi"] });

	assert.throws(
		() =>
			parseDecisionRequest({
				...base,
				context: { dataClassifications: "pii" },
			}),
		/invalid-data-classifications/u,
	);
	assert.throws(
		() =>
			parseDecisionRequest({
				...base,
				context: { dataClassifications: ["pii", "made-up"] },
			}),
		/unknown-data-classification/u,
	);
});
