/**
 * `parseFleetVerdict` (design §6.8, R14): the route job's parser for the
 * verdict route's protobuf JSON. A missing, stale or unreadable verdict is
 * `undefined`, which changes nothing about routing. The file has no imports,
 * so it loads with nothing installed.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFleetVerdict } from "../../src/verdict-wire.js";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const SOURCE = fileURLToPath(
	new URL("../../src/verdict-wire.ts", import.meta.url),
);

const wire = (fields: Readonly<Record<string, string | number | null>>) =>
	JSON.stringify({
		fleet: "hobo",
		label: "hobo",
		state: "VERDICT_STATE_OPEN",
		members: 2,
		freeSlots: 5,
		asOf: iso(NOW),
		expiresAt: iso(NOW + 120_000),
		...fields,
	});

describe("parseFleetVerdict", () => {
	it("reads each state and the free slots", () => {
		expect(parseFleetVerdict(wire({}), NOW)).toEqual({
			state: "OPEN",
			freeSlots: 5,
		});
		expect(
			parseFleetVerdict(wire({ state: "VERDICT_STATE_NO_MEMBER" }), NOW),
		).toEqual({ state: "NO_MEMBER", freeSlots: 5 });
		expect(
			parseFleetVerdict(wire({ state: "VERDICT_STATE_NO_CAPACITY" }), NOW),
		).toEqual({ state: "NO_CAPACITY", freeSlots: 5 });
	});

	it("accepts enum numbers, snake_case names and uint32 as strings, and reads an omitted zero as zero", () => {
		expect(parseFleetVerdict(wire({ state: 3 }), NOW)?.state).toBe(
			"NO_CAPACITY",
		);
		expect(
			parseFleetVerdict(
				JSON.stringify({
					state: "VERDICT_STATE_OPEN",
					free_slots: "7",
					as_of: iso(NOW),
					expires_at: iso(NOW + 1),
				}),
				NOW,
			),
		).toEqual({ state: "OPEN", freeSlots: 7 });
		expect(
			parseFleetVerdict(
				JSON.stringify({
					state: "VERDICT_STATE_NO_CAPACITY",
					asOf: iso(NOW),
					expiresAt: iso(NOW + 1),
				}),
				NOW,
			),
		).toEqual({ state: "NO_CAPACITY", freeSlots: 0 });
	});

	it("is undefined for an expired, overlong or future verdict", () => {
		expect(
			parseFleetVerdict(wire({ expiresAt: iso(NOW) }), NOW),
		).toBeUndefined();
		expect(
			parseFleetVerdict(wire({ expiresAt: iso(NOW + 300_001) }), NOW),
		).toBeUndefined();
		expect(
			parseFleetVerdict(
				wire({ asOf: iso(NOW + 61_000), expiresAt: iso(NOW + 120_000) }),
				NOW,
			),
		).toBeUndefined();
		expect(
			parseFleetVerdict(wire({ expiresAt: iso(NOW + 300_000) }), NOW),
		).toBeDefined();
	});

	it("is undefined for anything unreadable", () => {
		for (const json of [
			"",
			"not json",
			"null",
			"[]",
			"42",
			'"OPEN"',
			wire({ state: "VERDICT_STATE_UNSPECIFIED" }),
			wire({ state: "OPEN" }),
			wire({ state: 9 }),
			wire({ state: null }),
			wire({ freeSlots: -1 }),
			wire({ freeSlots: 1.5 }),
			wire({ freeSlots: "many" }),
			wire({ asOf: "now" }),
			wire({ expiresAt: null }),
			wire({ expiresAt: 5 }),
		])
			expect(parseFleetVerdict(json, NOW)).toBeUndefined();
	});

	it("has no imports and loads under node with types stripped", () => {
		const source = readFileSync(SOURCE, "utf8");
		expect(source).not.toMatch(/^\s*import\b/mu);
		expect(source).not.toMatch(/\brequire\(/u);
		expect(source).not.toMatch(/\bimport\(/u);
		execFileSync(process.execPath, ["--experimental-strip-types", SOURCE], {
			stdio: "pipe",
		});
	});
});
