/**
 * Runnable example for s0-03-hobo-core (HOBO-580). The draft-artifact gate EXECUTES this
 * with `node --import tsx` and diffs stdout against usage.expected.txt — keep both honest.
 *
 * Demonstrates the real @hobo/core draft contract against the committed test fixtures:
 * parse-don't-validate event envelopes (frozen records, family.PastTenseFact types),
 * lossless CloudEvent round-trips, WIT-style port descriptors with a duplicate-rejecting
 * container, and capability-manifest bundle parsing with issuer cross-checks.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
	CoreParseError,
	createContainer,
	createPortDescriptor,
	EnvelopeParseError,
	fromCloudEvent,
	ManifestParseError,
	parseCapabilityManifestBundle,
	parseEventEnvelope,
	PortDescriptorParseError,
	toCloudEvent,
} from "../src/index.ts";
import { type JsonValue } from "../src/json.js";


const fixture = (name: string): JsonValue =>
	JSON.parse(readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), "utf8"));

function mustThrow<E extends CoreParseError, T>(fn: () => T, kind: new (...args: never[]) => E): E {
	try {
		fn();
	} catch (error) {
		assert.ok(error instanceof kind, `expected ${kind.name}`);
		return error;
	}
	throw new Error(`expected ${kind.name} but nothing was thrown`);
}

// 1) Parse-don't-validate: the committed valid envelope fixture parses into a frozen record.
const envelope = parseEventEnvelope(fixture("valid-envelope.json"));
console.log(
	`envelope parsed: type=${envelope.type} seq=${envelope.seq} actor=${envelope.actor.kind}:${envelope.actor.id}`,
);
assert.ok(Object.isFrozen(envelope), "parsed envelope is deep-frozen");
assert.ok(Object.isFrozen(envelope.actor), "nested actor is frozen too");
console.log("envelope record frozen: true");

// 2) CloudEvent round-trip is lossless: envelope -> CloudEvent -> envelope.
const cloudEvent = toCloudEvent(envelope);
console.log(`cloudevent: source=${cloudEvent.source} subject=${cloudEvent.subject}`);
const roundTripped = fromCloudEvent(cloudEvent);
assert.deepEqual(roundTripped, envelope, "CloudEvent round-trip preserves the envelope");
console.log("cloudevent round-trip lossless: true");

// 3) Malformed fixtures are rejected with typed errors, never half-parsed records.
const badSeq = mustThrow(() => parseEventEnvelope(fixture("malformed-envelope.json")), EnvelopeParseError);
console.log(`rejected: code=${badSeq.code} path=${badSeq.path} expected=${badSeq.expected}`);
const badActor = mustThrow(
	() => parseEventEnvelope(fixture("malformed-envelope-actor.json")),
	EnvelopeParseError,
);
console.log(`rejected: code=${badActor.code} path=${badActor.path} expected=${badActor.expected}`);

// 4) Port descriptors demand WIT-style interface refs; the container refuses duplicates.
const cachePort = createPortDescriptor({
	kind: "port",
	name: "cache",
	interface: "hobo:data/cache@1.0.0",
	stability: "preview",
});
console.log(
	`port descriptor: ${cachePort.kind}/${cachePort.name} -> ${cachePort.interface} (${cachePort.stability})`,
);
mustThrow(
	() =>
		createPortDescriptor({ kind: "port", name: "bad", interface: "not a wit ref", stability: "stable" }),
	PortDescriptorParseError,
);
console.log("non-WIT interface ref rejected: true");

const container = createContainer();
container.register(cachePort, { name: "sim-cache" });
assert.deepEqual(container.resolve(cachePort), { name: "sim-cache" });
assert.throws(() => container.register(cachePort, { name: "second" }), /already registered/);
console.log("container: resolve ok, duplicate registration rejected");

// 5) Capability-manifest bundle: the committed 4-file fixture parses; flow order is normalized.
const bundle = parseCapabilityManifestBundle({
	index: fixture("valid-manifest-bundle/index.json"),
	capabilities: fixture("valid-manifest-bundle/capabilities.json"),
	auth: fixture("valid-manifest-bundle/auth.json"),
	cost: fixture("valid-manifest-bundle/cost.json"),
});
console.log(
	`manifest bundle: issuer=${bundle.index.issuer} ports=${bundle.capabilities.ports.map((p) => p.port).join(",")} flows=${bundle.auth.flows.map((f) => f.type).join(",")}`,
);
assert.equal(bundle.auth.issuer, bundle.index.issuer, "auth issuer matches index issuer");

// 6) The malformed bundle (auth issuer != index issuer) is rejected at the boundary.
const badBundle = mustThrow(
	() => parseCapabilityManifestBundle(fixture("malformed-manifest-issuer.json")),
	ManifestParseError,
);
console.log(`rejected: code=${badBundle.code} path=${badBundle.path} expected=${badBundle.expected}`);

console.log(
	"CONTRACT HELD: core parses-not-validates envelopes, ports, and manifests into frozen typed records",
);
