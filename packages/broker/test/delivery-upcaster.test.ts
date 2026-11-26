import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	DELIVERY_SUBMITTED_SCHEMA,
	upcastDeliverySubmitted,
} from "../src/delivery.js";
import type { JsonObject } from "../src/json.js";

// Golden upcaster corpus for persisted broker.DeliverySubmitted facts (D14).
// One real body per shipped shape, append-only: v1 named an engine
// (argo | in-proc); v2 names a reconciler mode and an optional publisher.
const corpusDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures/delivery-submitted",
);
const corpus = readdirSync(corpusDir)
	.filter((name) => name.endsWith(".json"))
	.sort()
	.map((name) => ({
		name,
		// SAFETY: assertion required at this I/O or test boundary.
		entry: JSON.parse(readFileSync(join(corpusDir, name), "utf8")) as {
			input: JsonObject;
			expected: JsonObject;
		},
	}));

describe("broker.DeliverySubmitted upcaster", () => {
	it("covers every shipped body shape", () => {
		expect(corpus.map((c) => c.name)).toEqual([
			"v1-argo.json",
			"v1-in-proc.json",
			"v2-publisher.json",
		]);
	});

	for (const { name, entry } of corpus) {
		it(`lifts ${name} to the current schema`, () => {
			const lifted = upcastDeliverySubmitted(entry.input);
			expect(lifted).toEqual(entry.expected);
			expect(lifted.schema).toBe(DELIVERY_SUBMITTED_SCHEMA);
			// Idempotent: the current shape is a fixed point.
			expect(upcastDeliverySubmitted(lifted)).toEqual(lifted);
		});
	}

	it("refuses a body it cannot lift instead of guessing", () => {
		expect(() =>
			upcastDeliverySubmitted({
				requestId: "r",
				brokerId: "b",
				engine: "helm",
			}),
		).toThrow(/delivery-fact-unknown/);
		expect(() =>
			upcastDeliverySubmitted({
				schema: "hobo.broker.delivery-submitted/v9",
				requestId: "r",
			}),
		).toThrow(/delivery-fact-unknown/);
	});
});
