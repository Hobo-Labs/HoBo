import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { componentizeHelloBindle } from "../src/componentize.js";
import {
	createRealComponentize,
	type RealComponentizeImpl,
} from "../src/real-componentize.js";
import {
	assertSourceDateEpoch,
	parseSourceDateEpochMs,
	sourceDateEpochToUnixSeconds,
} from "../src/source-date-epoch.js";

const MAX_SECONDS = 8_640_000_000_000;

const invalidEpochs = [
	"",
	"-1",
	"1969-12-31T23:59:59Z",
	"2026-01-01T00:00:00",
	"Jan 1 2026",
	"2026-02-30T00:00:00Z",
	"2025-02-29T00:00:00Z",
	"2026-01-01T24:00:00Z",
	String(MAX_SECONDS + 1),
	String(Number.MAX_SAFE_INTEGER),
	"9".repeat(400),
];

describe("component build epoch", () => {
	it("round-trips generated nonnegative whole-second values exactly", () => {
		// Include the upper limit as well as a deterministic spread across the range.
		let state = 0x1a2b3c4d;
		const samples = [0, 1, MAX_SECONDS - 1, MAX_SECONDS];
		for (let i = 0; i < 300; i++) {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			samples.push(Math.floor((state / 0x1_0000_0000) * MAX_SECONDS));
		}
		for (const seconds of samples) {
			const input = String(seconds);
			expect(parseSourceDateEpochMs(input)).toBe(seconds * 1000);
			expect(sourceDateEpochToUnixSeconds(input)).toBe(input);
		}
	});

	it("accepts explicit time zones and converts fractional seconds consistently", () => {
		for (const [input, seconds] of [
			["1970-01-01", "0"],
			["1970-01-01T01:00:00+01:00", "0"],
			["2026-01-01T00:00:00.999Z", "1767225600"],
			["2025-12-31T19:00:00-05:00", "1767225600"],
		]) {
			expect(sourceDateEpochToUnixSeconds(input)).toBe(seconds);
		}
	});

	it("round-trips generated ISO timestamps to their Unix second", () => {
		let state = 0x3854a1f3;
		for (let i = 0; i < 300; i++) {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			const seconds = Math.floor((state / 0x1_0000_0000) * 253_402_300_799);
			const timestamp = new Date(seconds * 1000 + (state % 1000)).toISOString();
			expect(sourceDateEpochToUnixSeconds(timestamp), timestamp).toBe(
				String(seconds),
			);
		}
		expect(sourceDateEpochToUnixSeconds("2024-02-29T00:00:00Z")).toBe(
			"1709164800",
		);
	});

	it("rejects unrepresentable, ambiguous, or invalid times", () => {
		for (const input of invalidEpochs) {
			expect(Number.isNaN(parseSourceDateEpochMs(input)), input).toBe(true);
			expect(() => assertSourceDateEpoch(input), input).toThrow(
				/invalid_source_date_epoch/,
			);
			expect(() => sourceDateEpochToUnixSeconds(input), input).toThrow(
				/invalid_source_date_epoch/,
			);
		}
	});

	let sourceRoot = "";
	beforeAll(() => {
		sourceRoot = mkdtempSync(join(tmpdir(), "hobo-source-date-epoch-"));
	});
	afterAll(() => {
		rmSync(sourceRoot, { recursive: true, force: true });
	});

	it("both build paths reject invalid epochs before invoking the build", async () => {
		let calls = 0;
		const impl: RealComponentizeImpl = async () => {
			calls++;
			return { component: new Uint8Array() };
		};
		const real = await createRealComponentize({ componentizeImpl: impl });
		for (const sourceDateEpoch of invalidEpochs) {
			await expect(
				componentizeHelloBindle({ sourceRoot, sourceDateEpoch }),
			).rejects.toThrow(/invalid_source_date_epoch/);
			await expect(
				real.componentize({ sourceRoot, sourceDateEpoch }),
			).rejects.toThrow(/invalid_source_date_epoch/);
		}
		expect(calls).toBe(0);
	});
});
