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

const preview = analyzeAuthorTimeCapabilityFeedback({
	catalogContentHash: "cat-1",
	resource,
	requests: [{ port: "queue", feature: "fifo", strictness: "prefer" }],
	providers,
});
assert.equal(preview.findings.length, 1);
console.log(`preview: code=${preview.findings[0].code} severity=${preview.findings[0].severity}`);

const missing = analyzeAuthorTimeCapabilityFeedback({
	catalogContentHash: "cat-1",
	resource,
	requests: [{ port: "blob", feature: "signed-url", strictness: "require" }],
	providers,
});
assert.equal(missing.findings.length, 1);
console.log(`missing: code=${missing.findings[0].code} severity=${missing.findings[0].severity}`);

const stale = analyzeAuthorTimeCapabilityFeedback({
	catalogContentHash: "cat-1",
	deployCatalogContentHash: "cat-2",
	resource,
	requests: [{ port: "kv", feature: "ttl", strictness: "require" }],
	providers,
});
assert.ok(stale.findings.some((f) => f.code === "catalog.snapshot.stale"));
console.log(`stale: codes=${stale.findings.map((f) => f.code).join(",")}`);

const rendered = renderHoboPlanFeedback(stale);
assert.ok(isJsonString(rendered) || Array.isArray(rendered));
console.log(`rendered lines: ${(Array.isArray(rendered) ? rendered : rendered.split("\n")).length}`);

console.log("CONTRACT HELD: author-time findings advise; deploy-time PlanRejected stays authoritative");
