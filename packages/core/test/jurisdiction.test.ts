// ADR-0146: legal-jurisdiction vocabulary + the pure residency evaluator that
// turns "constraint + target region" into an explicit, fail-closed verdict.
import assert from "node:assert/strict";
import { test } from "vitest";

import {
	evaluateResidency,
	JURISDICTIONS,
	jurisdictionsForRegion,
	parseResidencyConstraint,
	REGION_JURISDICTIONS,
} from "../src/ports/jurisdiction.js";

const EU_PII = parseResidencyConstraint({
	classifications: ["pii", "phi"],
	allowedJurisdictions: ["eu", "eea"],
});

test("every shipped provider default region token is mapped", () => {
	// Tokens published by providers today (aws/gcp/kafka/convex/lakebed docs).
	const shipped = [
		"us-east-1",
		"us-west-2",
		"eu-west-1",
		"us-central1",
		"us-east1",
		"europe-west1",
		"us",
		"global",
		"local",
	];
	for (const region of shipped) {
		assert.ok(
			jurisdictionsForRegion(region).length > 0,
			`region ${region} must be mapped`,
		);
	}
});

test("catalog invariants: every mapped jurisdiction id exists in the catalog", () => {
	const known = new Set(JURISDICTIONS.map((entry) => entry.id));
	for (const [region, ids] of Object.entries(REGION_JURISDICTIONS)) {
		for (const id of ids) {
			assert.ok(known.has(id), `${region} maps to unknown jurisdiction ${id}`);
		}
	}
});

test("an EU-only constraint allows EU regions and rejects US regions with remediation", () => {
	const ok = evaluateResidency({ constraint: EU_PII, region: "eu-west-1" });
	assert.equal(ok.ok, true);
	if (!ok.ok) return;
	assert.deepEqual(ok.regionJurisdictions, ["eu", "eea"]);

	const bad = evaluateResidency({ constraint: EU_PII, region: "us-east-1" });
	assert.equal(bad.ok, false);
	if (bad.ok) return;
	assert.equal(bad.code, "jurisdiction-not-allowed");
	assert.match(bad.remediation, /outside allowed jurisdictions/u);
});

test("fail closed: an unmapped region is a conflict, never a pass", () => {
	const verdict = evaluateResidency({
		constraint: EU_PII,
		region: "mars-north-1",
	});
	assert.equal(verdict.ok, false);
	if (verdict.ok) return;
	assert.equal(verdict.code, "region-unmapped");
});

test("denied jurisdictions override allowed membership", () => {
	const constraint = parseResidencyConstraint({
		classifications: ["pii"],
		allowedJurisdictions: ["global"],
		deniedJurisdictions: ["us-gov"],
	});
	const verdict = evaluateResidency({ constraint, region: "us-gov-west-1" });
	assert.equal(verdict.ok, false);
	if (verdict.ok) return;
	assert.equal(verdict.code, "jurisdiction-denied");
	// global allows everything else
	assert.equal(evaluateResidency({ constraint, region: "us-east-1" }).ok, true);
});

test("region tokens normalize (case/whitespace) before lookup", () => {
	assert.equal(
		evaluateResidency({ constraint: EU_PII, region: "  EU-WEST-1 " }).ok,
		true,
	);
});

test("parse fails closed: empty allow-list and unknown ids are rejected", () => {
	assert.throws(
		() =>
			parseResidencyConstraint({
				classifications: [],
				allowedJurisdictions: [],
			}),
		/non-empty/u,
	);
	assert.throws(
		() =>
			parseResidencyConstraint({
				classifications: ["pii"],
				allowedJurisdictions: ["atlantis"],
			}),
		/unknown jurisdiction/u,
	);
});

test("ok evaluations carry an intra-jurisdiction transfer basis", () => {
	const verdict = evaluateResidency({
		constraint: EU_PII,
		region: "eu-west-1",
	});
	assert.equal(verdict.ok, true);
	if (!verdict.ok) return;
	assert.equal(verdict.transferBasis.mechanism, "intra-jurisdiction");
	assert.equal(verdict.transferBasis.fromJurisdiction, "eu");
});

test("transfer mechanisms are opt-in: default mode never widens", () => {
	const strict = evaluateResidency({ constraint: EU_PII, region: "us-east-1" });
	assert.equal(strict.ok, false);
});

test("adequacy mode passes an EU constraint into a DPF-covered US region with the citation", () => {
	const verdict = evaluateResidency({
		constraint: EU_PII,
		region: "us-east-1",
		transferMechanisms: "adequacy",
	});
	assert.equal(verdict.ok, true);
	if (!verdict.ok) return;
	assert.equal(verdict.transferBasis.mechanism, "adequacy");
	assert.equal(verdict.transferBasis.toJurisdiction, "us");
	assert.match(
		verdict.transferBasis.legalBasis.join(" "),
		/Data Privacy Framework/u,
	);
});

test("SCC needs the wider adequacy-or-scc mode", () => {
	const adequacyOnly = evaluateResidency({
		constraint: EU_PII,
		region: "ap-south",
		transferMechanisms: "adequacy",
	});
	assert.equal(adequacyOnly.ok, false);
	if (adequacyOnly.ok === false) {
		assert.match(adequacyOnly.remediation, /no recognized transfer mechanism/u);
	}
	const withScc = evaluateResidency({
		constraint: EU_PII,
		region: "ap-south",
		transferMechanisms: "adequacy-or-scc",
	});
	assert.equal(withScc.ok, true);
	if (!withScc.ok) return;
	assert.equal(withScc.transferBasis.mechanism, "scc");
});

test("transfer mechanisms never bypass denied jurisdictions or unmapped regions", () => {
	const denied = evaluateResidency({
		constraint: parseResidencyConstraint({
			classifications: ["pii"],
			allowedJurisdictions: ["eu"],
			deniedJurisdictions: ["us"],
		}),
		region: "us-east-1",
		transferMechanisms: "adequacy-or-scc",
	});
	assert.equal(denied.ok, false);
	if (denied.ok === false) assert.equal(denied.code, "jurisdiction-denied");

	const unmapped = evaluateResidency({
		constraint: EU_PII,
		region: "atlantis-1",
		transferMechanisms: "adequacy-or-scc",
	});
	assert.equal(unmapped.ok, false);
	if (unmapped.ok === false) assert.equal(unmapped.code, "region-unmapped");
});
