/**
 * Runnable example for s2-08-provider-cloudflare (HOBO-623). The draft-artifact gate
 * EXECUTES this with `node --import tsx` and diffs stdout against usage.expected.txt —
 * keep both honest.
 *
 * Demonstrates the real @hobo/provider-cloudflare draft contract: the provider covers the
 * three initial capability ports via published equivalence classes, publishes a canonical
 * 4-document well-known capability manifest (no static secrets, deterministic bytes),
 * and plans the hello-bindle app with typed Cloudflare option blocks and WASI binds.
 */
import { strict as assert } from "node:assert";

import {
	CLOUDFLARE_PROVIDER_ID,
	cloudflare,
	createProviderCloudflareDraft,
	EQUIVALENCE_CLASSES,
	equivalenceForPort,
	INITIAL_CAPABILITY_PORTS,
	MANIFEST_SCHEMA,
	parsePublishedManifest,
	publishCapabilityManifest,
	type PublishedManifestDocuments,
} from "../src/index.ts";
import { type JsonObject } from "../src/json.js";


// 1) The provider draft covers every initial capability port through equivalence classes.
const provider = createProviderCloudflareDraft();
console.log(`provider: ${provider.id}`);
for (const port of INITIAL_CAPABILITY_PORTS) {
	const mapping = equivalenceForPort(port);
	assert.ok(provider.coversInitialPort(port), `provider covers ${port}`);
	console.log(`port ${port} -> ${mapping.resourceClass} (${mapping.providerService}) features=${mapping.features.join(",")}`);
}
assert.equal(INITIAL_CAPABILITY_PORTS.length, Object.keys(EQUIVALENCE_CLASSES).length);

// 2) The published manifest is the 4-document well-known set, and it parses clean.
const documents = provider.publishedManifest;
for (const path of Object.keys(documents).sort()) {
	console.log(`published: ${path}`);
}
const parsed = parsePublishedManifest(documents);
assert.ok(parsed.ok, `manifest parses without errors: ${parsed.errors.join("; ")}`);
assert.equal(parsed.index.manifestSchema, MANIFEST_SCHEMA);
assert.equal(parsed.auth.staticSecrets, false);
console.log(`manifest parse ok=${parsed.ok} schema=${MANIFEST_SCHEMA} staticSecrets=false`);

// 3) Publication is deterministic: same input, byte-identical canonical documents.
const republished = publishCapabilityManifest({ colos: ["WNAM", "ENAM", "WEUR"] });
assert.deepEqual(republished, documents, "canonical manifest bytes are reproducible");
console.log("manifest bytes deterministic: true");

// 4) A tampered manifest that leaks a static secret is rejected at the parse boundary.
// SAFETY: `const tamperedAuth = JSON.parse(documents["/.well-known/capability-manifest/auth` is required at this I/O or test boundary.
const tamperedAuth = JSON.parse(documents["/.well-known/capability-manifest/auth.json"]) as JsonObject;
tamperedAuth.staticKey = "sk-oops";
const tampered: PublishedManifestDocuments = {
	...documents,
	"/.well-known/capability-manifest/auth.json": JSON.stringify(tamperedAuth),
};
const rejected = parsePublishedManifest(tampered);
assert.equal(rejected.ok, false);
console.log(`tampered manifest rejected: ${rejected.errors.join("; ")}`);

// 5) The hello-bindle plan binds compute to kv/objectStore with typed option blocks.
const plan = provider.helloBindlePlan;
console.log(`plan ${plan.id}: env=${plan.context.env} colo=${plan.context.colo} resources=${plan.resources.map((r) => `${r.id}:${r.type}`).join(",")}`);
const service = plan.resources.find((resource) => resource.id === "service");
assert.ok(service);
const binds = service.binds ?? [];
for (const bind of binds) {
	console.log(`bind: ${bind.import} -> ${bind.providerResourceId} (${bind.capability})`);
}

// 6) Typed option blocks merge caller overrides over provider defaults.
const worker = cloudflare.with.worker({ cpuMs: 50 });
assert.equal(worker.providerId, "cloudflare");
assert.equal(worker.options.cpuMs, 50, "override wins");
assert.equal(worker.options.memoryMb, 128, "defaults survive");
console.log(`option block: port=${worker.port} name=${worker.optionName} negotiation=${worker.negotiation} cpuMs=${worker.options.cpuMs} memoryMb=${worker.options.memoryMb}`);
assert.equal(provider.id, CLOUDFLARE_PROVIDER_ID);

console.log("CONTRACT HELD: cloudflare provider publishes a canonical, secret-free capability manifest covering the initial ports");
