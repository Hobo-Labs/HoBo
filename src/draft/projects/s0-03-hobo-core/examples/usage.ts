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

const envelope = parseEventEnvelope(fixture("valid-envelope.json"));
console.log(
	`envelope parsed: type=${envelope.type} seq=${envelope.seq} actor=${envelope.actor.kind}:${envelope.actor.id}`,
);
assert.ok(Object.isFrozen(envelope), "parsed envelope is deep-frozen");
assert.ok(Object.isFrozen(envelope.actor), "nested actor is frozen too");
console.log("envelope record frozen: true");

const cloudEvent = toCloudEvent(envelope);
console.log(`cloudevent: source=${cloudEvent.source} subject=${cloudEvent.subject}`);
const roundTripped = fromCloudEvent(cloudEvent);
assert.deepEqual(roundTripped, envelope, "CloudEvent round-trip preserves the envelope");
console.log("cloudevent round-trip lossless: true");

const badSeq = mustThrow(() => parseEventEnvelope(fixture("malformed-envelope.json")), EnvelopeParseError);
console.log(`rejected: code=${badSeq.code} path=${badSeq.path} expected=${badSeq.expected}`);
const badActor = mustThrow(
	() => parseEventEnvelope(fixture("malformed-envelope-actor.json")),
	EnvelopeParseError,
);
console.log(`rejected: code=${badActor.code} path=${badActor.path} expected=${badActor.expected}`);

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

const badBundle = mustThrow(
	() => parseCapabilityManifestBundle(fixture("malformed-manifest-issuer.json")),
	ManifestParseError,
);
console.log(`rejected: code=${badBundle.code} path=${badBundle.path} expected=${badBundle.expected}`);

console.log(
	"CONTRACT HELD: core parses-not-validates envelopes, ports, and manifests into frozen typed records",
);
