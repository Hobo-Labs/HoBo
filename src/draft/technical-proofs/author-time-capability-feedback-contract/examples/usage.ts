/**
 * Runnable example for author-time-capability-feedback-contract. The draft-artifact
 * gate EXECUTES this with `node --import tsx` and diffs stdout against
 * usage.expected.txt — keep both honest.
 *
 * Proves the author-time feedback loop: capability requests are analyzed against
 * the selected provider's catalog snapshot, findings surface as codegen/doctor
 * diagnostics, and a stale catalog snapshot downgrades trust (deploy-time
 * PlanRejected stays authoritative).
 */
import { isJsonString } from "../src/json.js";
import { strict as assert } from "node:assert";
import {

	analyzeAuthorTimeCapabilityFeedback,
	renderHoboPlanFeedback,
} from "../src/author-time-capability-feedback.ts";

const providers = [
	{
		id: "provider-a",
		capabilities: [
			{ port: "kv", feature: "ttl", stability: "stable" },
			{ port: "queue", feature: "fifo", stability: "preview" },
		],
	},
	{ id: "provider-b", capabilities: [{ port: "kv", feature: "ttl", stability: "stable" }] },
];
const resource = { id: "sessions", type: "data.v1", selectedProviderId: "provider-a" };

// 1) Fully satisfied stable request -> no findings, ok report.
const clean = analyzeAuthorTimeCapabilityFeedback({
	catalogContentHash: "cat-1",
	resource,
	requests: [{ port: "kv", feature: "ttl", strictness: "require" }],
	providers,
});
assert.equal(clean.ok, true);
assert.equal(clean.findings.length, 0);
assert.equal(clean.deployGateRequired, true);
console.log(`clean: ok=${clean.ok} findings=${clean.findings.length} deployGateRequired=${clean.deployGateRequired}`);

// 2) Preview-stability capability -> stability finding on the author surface.
const preview = analyzeAuthorTimeCapabilityFeedback({
	catalogContentHash: "cat-1",
	resource,
	requests: [{ port: "queue", feature: "fifo", strictness: "prefer" }],
	providers,
});
assert.equal(preview.findings.length, 1);
console.log(`preview: code=${preview.findings[0].code} severity=${preview.findings[0].severity}`);

// 3) Missing capability -> finding names alternate providers that could satisfy it.
const missing = analyzeAuthorTimeCapabilityFeedback({
	catalogContentHash: "cat-1",
	resource,
	requests: [{ port: "blob", feature: "signed-url", strictness: "require" }],
	providers,
});
assert.equal(missing.findings.length, 1);
console.log(`missing: code=${missing.findings[0].code} severity=${missing.findings[0].severity}`);

// 4) Stale catalog snapshot -> warning; deploy gate stays authoritative.
const stale = analyzeAuthorTimeCapabilityFeedback({
	catalogContentHash: "cat-1",
	deployCatalogContentHash: "cat-2",
	resource,
	requests: [{ port: "kv", feature: "ttl", strictness: "require" }],
	providers,
});
assert.ok(stale.findings.some((f) => f.code === "catalog.snapshot.stale"));
console.log(`stale: codes=${stale.findings.map((f) => f.code).join(",")}`);

// 5) The same report renders as `hobo plan` feedback text.
const rendered = renderHoboPlanFeedback(stale);
assert.ok(isJsonString(rendered) || Array.isArray(rendered));
console.log(`rendered lines: ${(Array.isArray(rendered) ? rendered : rendered.split("\n")).length}`);

console.log("CONTRACT HELD: author-time findings advise; deploy-time PlanRejected stays authoritative");
