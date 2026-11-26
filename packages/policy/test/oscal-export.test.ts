// OSCAL-JSON boundary emitter (docs/standards/oscal.md posture): OSCAL-shaped
// plain JSON, deterministic, zero OSCAL schema dependency.
import assert from "node:assert/strict";
import { test } from "vitest";

import {
	evaluateControlCoverage,
	NIST_800_53_SEED_PACK,
} from "../src/control-evidence-pack.js";
import {
	emitOscalAssessmentEvidence,
	emitOscalComponentDefinition,
	OSCAL_VERSION,
	summarizeOscalExport,
} from "../src/oscal-export.js";
import { SOC2_SEED_PACK } from "../src/seed-packs.js";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

test("component-definition: deterministic — emitting twice yields deepEqual documents", () => {
	const options = { componentTitle: "HoBo platform" };
	const first = emitOscalComponentDefinition(NIST_800_53_SEED_PACK, options);
	const second = emitOscalComponentDefinition(NIST_800_53_SEED_PACK, options);
	assert.deepEqual(first, second);
	assert.match(first["component-definition"].uuid, UUID_PATTERN);
	// A different title is a different document identity.
	const other = emitOscalComponentDefinition(NIST_800_53_SEED_PACK, {
		componentTitle: "Other component",
	});
	assert.notEqual(
		other["component-definition"].uuid,
		first["component-definition"].uuid,
	);
});

test("component-definition: one implemented-requirement per control, lowercased ids, hobo props", () => {
	const doc = emitOscalComponentDefinition(NIST_800_53_SEED_PACK, {
		componentTitle: "HoBo platform",
		componentDescription: "Cloud-agnostic AI-native hosting platform",
	});
	const definition = doc["component-definition"];
	assert.equal(definition.metadata["oscal-version"], OSCAL_VERSION);
	assert.equal(definition.metadata.version, NIST_800_53_SEED_PACK.version);
	assert.equal(definition.components.length, 1);
	const component = definition.components[0];
	assert.ok(component);
	assert.equal(component.type, "software");
	assert.equal(
		component.description,
		"Cloud-agnostic AI-native hosting platform",
	);
	const implementation = component["control-implementations"][0];
	assert.ok(implementation);
	assert.equal(implementation.source, NIST_800_53_SEED_PACK.framework);
	const requirements = implementation["implemented-requirements"];
	assert.equal(requirements.length, NIST_800_53_SEED_PACK.controls.length);
	const ac3 = requirements.find((entry) => entry["control-id"] === "ac-3");
	assert.ok(ac3);
	assert.match(ac3.uuid, UUID_PATTERN);
	assert.match(ac3.description, /Access enforcement/u);
	assert.match(ac3.description, /event-stream:policy\.Decided/u);
	assert.deepEqual(ac3.props, [
		{ name: "hobo-status", value: "implemented" },
		{ name: "hobo-evidence", value: "event-stream:policy.Decided" },
		{ name: "hobo-evidence", value: "gate:gatekeeper.Decided" },
	]);
	// Unique requirement uuids across controls.
	assert.equal(
		new Set(requirements.map((entry) => entry.uuid)).size,
		requirements.length,
	);
	assert.ok(Object.isFrozen(definition));
	assert.ok(Object.isFrozen(ac3.props));
});

test("assessment evidence: missing controls are not-satisfied with refs in remarks", () => {
	const report = evaluateControlCoverage(SOC2_SEED_PACK, [
		"event-stream:policy.Decided",
		"gate:gatekeeper.Decided",
		"gate:capability-grants",
	]);
	const doc = emitOscalAssessmentEvidence(report, SOC2_SEED_PACK);
	const results = doc["assessment-results"].results[0];
	assert.ok(results);
	assert.equal(results.findings.length, SOC2_SEED_PACK.controls.length);
	const cc61 = results.findings.find(
		(entry) => entry.target["target-id"] === "cc6.1",
	);
	assert.equal(cc61?.target.status.state, "satisfied");
	assert.equal(cc61?.target.remarks, undefined);
	const cc63 = results.findings.find(
		(entry) => entry.target["target-id"] === "cc6.3",
	);
	assert.equal(cc63?.target.status.state, "not-satisfied");
	assert.match(cc63?.target.remarks ?? "", /event-stream:connection\.Revoked/u);
	assert.match(
		cc63?.target.remarks ?? "",
		/artifact:connection-revocation-audit/u,
	);
	// Deterministic here too.
	assert.deepEqual(doc, emitOscalAssessmentEvidence(report, SOC2_SEED_PACK));
});

test("assessment evidence: a report from another framework is rejected", () => {
	const report = evaluateControlCoverage(NIST_800_53_SEED_PACK, []);
	assert.throws(
		() => emitOscalAssessmentEvidence(report, SOC2_SEED_PACK),
		/does not match pack framework/u,
	);
});

test("export summary mirrors the wire record shape", () => {
	assert.deepEqual(
		summarizeOscalExport("component-definition", SOC2_SEED_PACK),
		{
			kind: "component-definition",
			framework: "SOC 2 Trust Services Criteria",
			version: "2017-seed",
			control_count: 8,
		},
	);
});
