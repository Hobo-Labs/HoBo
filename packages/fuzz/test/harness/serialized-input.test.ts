import { describe, expect, it } from "vitest";

import {
	type FuzzValue,
	fuzzBindleManifest,
	fuzzEventEnvelope,
	fuzzPolicyDocument,
	hasPrototypePollution,
	MAX_HARNESS_BYTES,
	sampleManifestRecord,
} from "../../src/index.js";

function bytes(value: FuzzValue): Uint8Array {
	return Buffer.from(JSON.stringify(value));
}

describe("Jazzer-shaped serialized-input harnesses", () => {
	it("accepts a well-formed bindle manifest without throwing", () => {
		expect(() =>
			fuzzBindleManifest(bytes(sampleManifestRecord())),
		).not.toThrow();
	});

	it("rejects prototype pollution instead of crashing", () => {
		const polluted = {
			schema: "hobo.manifest/v1",
			constructor: { admin: true },
		};
		expect(hasPrototypePollution(polluted)).toBe(true);
		expect(() => fuzzBindleManifest(bytes(polluted))).not.toThrow();
		expect(() => fuzzEventEnvelope(bytes(polluted))).toThrow(
			/__proto__|constructor/,
		);
		expect(() => fuzzPolicyDocument(bytes(polluted))).toThrow(
			/unexpected properties/,
		);
	});

	it("bounds resource use on oversized buffers", () => {
		const huge = new Uint8Array(MAX_HARNESS_BYTES + 8);
		huge.fill(0x61);
		expect(() => fuzzBindleManifest(huge)).not.toThrow();
		expect(() => fuzzEventEnvelope(huge)).not.toThrow();
	});

	it("treats garbage and allow-without-resource as fail-closed", () => {
		expect(() => fuzzBindleManifest(Buffer.from("not-json"))).not.toThrow();
		expect(() => fuzzPolicyDocument(bytes({ effect: "allow" }))).not.toThrow();
	});
});
