import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	createEventEnvelope,
	EnvelopeParseError,
	fromCloudEvent,
	parseEventEnvelope,
	toCloudEvent,
} from "../src/index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("EventEnvelope", () => {
	it("parses a valid envelope fixture and deep-freezes the result", () => {
		const raw = JSON.parse(
			readFileSync(join(fixturesDir, "valid-envelope.json"), "utf8"),
		);
		const envelope = parseEventEnvelope(raw);

		expect(envelope.type).toBe("identity.Issued");
		expect(envelope.seq).toBe(7);
		expect(Object.isFrozen(envelope)).toBe(true);
		expect(Object.isFrozen(envelope.actor)).toBe(true);
	});

	it("rejects malformed envelope with EnvelopeParseError naming the offending field", () => {
		const raw = JSON.parse(
			readFileSync(join(fixturesDir, "malformed-envelope.json"), "utf8"),
		);

		expect(() => parseEventEnvelope(raw)).toThrow(EnvelopeParseError);
		try {
			parseEventEnvelope(raw);
		} catch (error) {
			expect(error).toBeInstanceOf(EnvelopeParseError);
			// SAFETY: assertion required at this I/O or test boundary.
			expect((error as EnvelopeParseError).path).toBe("streamId");
		}
	});

	it("rejects actor kind outside the enum", () => {
		const raw = JSON.parse(
			readFileSync(join(fixturesDir, "malformed-envelope-actor.json"), "utf8"),
		);

		expect(() => parseEventEnvelope(raw)).toThrow(EnvelopeParseError);
		try {
			parseEventEnvelope(raw);
		} catch (error) {
			// SAFETY: assertion required at this I/O or test boundary.
			expect((error as EnvelopeParseError).path).toBe("actor.kind");
		}
	});

	it("rejects invalid event type pattern", () => {
		const raw = JSON.parse(
			readFileSync(join(fixturesDir, "valid-envelope.json"), "utf8"),
		);
		raw.type = "invalid-type";

		expect(() => parseEventEnvelope(raw)).toThrow(EnvelopeParseError);
		try {
			parseEventEnvelope(raw);
		} catch (error) {
			// SAFETY: assertion required at this I/O or test boundary.
			expect((error as EnvelopeParseError).path).toBe("type");
		}
	});

	it("round-trips through CloudEvents losslessly", () => {
		const raw = JSON.parse(
			readFileSync(join(fixturesDir, "valid-envelope.json"), "utf8"),
		);
		const envelope = createEventEnvelope(raw);
		const roundTripped = fromCloudEvent(toCloudEvent(envelope));

		expect(roundTripped).toEqual(envelope);
		expect(Object.isFrozen(roundTripped)).toBe(true);
	});

	it("throws when mutating a frozen envelope in strict mode", () => {
		const raw = JSON.parse(
			readFileSync(join(fixturesDir, "valid-envelope.json"), "utf8"),
		);
		const envelope = parseEventEnvelope(raw);

		expect(() => {
			// SAFETY: assertion required at this I/O or test boundary.
			(envelope as { seq: number }).seq = 99;
		}).toThrow();
	});
});
