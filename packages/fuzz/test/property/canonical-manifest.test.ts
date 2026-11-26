import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
	hashManifest,
	parseOrReject,
	sampleManifestRecord,
} from "../../src/index.js";

describe("equivalent manifests produce equivalent normalized plans", () => {
	it("shuffled resource insertion order keeps the canonical hash", () => {
		fc.assert(
			fc.property(
				fc.shuffledSubarray(["db", "api", "site"] as const, {
					minLength: 3,
					maxLength: 3,
				}),
				(order) => {
					expect(hashManifest(sampleManifestRecord(order))).toBe(
						hashManifest(sampleManifestRecord(["site", "api", "db"])),
					);
				},
			),
			{ numRuns: 32 },
		);
	});

	it("unknown top-level keys do not change the canonical hash", () => {
		const base = sampleManifestRecord(["db", "api", "site"]);
		expect(hashManifest({ ...base, extra: 1, note: "ignored" })).toBe(
			hashManifest(base),
		);
	});

	it("rejects polluted or untyped documents fail-closed", () => {
		expect(parseOrReject({ __proto__: { admin: true } })).toBe("rejected");
		expect(parseOrReject({ schema: "nope" })).toBe("rejected");
		expect(parseOrReject(sampleManifestRecord())).not.toBe("rejected");
	});
});
