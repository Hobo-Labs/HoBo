import { type CapabilitySlot, capability } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	DEFAULT_REGIONS,
	HOSTINGER_DEFAULT_BINDINGS,
	hostingerYardSpec,
} from "../src/index.js";

/**
 * Every published capability profile, derived from `@hobo/core`'s catalog
 * rather than restated here.
 *
 * This used to be a hand-written list, and it drifted the moment a factory was
 * pointed at a more specific profile — the test failed for the list's reason,
 * not the catalog's. Deriving it means a profile the core vocabulary adds is
 * automatically legal, and a profile it does not define still fails.
 */
const REAL_PROFILES: readonly string[] = Object.values(capability).flatMap(
	(family) => Object.values(family),
);

/** Entries declared for one slot, or an empty list when the slot is absent. */
function slotEntries(slot: CapabilitySlot) {
	return HOSTINGER_DEFAULT_BINDINGS[slot] ?? [];
}

describe("the Hostinger Yard is an allocatable catalog", () => {
	it.each([
		["web", "web.hosted/v1", "hostinger.vps/v1"],
		["api", "api.http/v1", "hostinger.dns-zone/v1"],
		["service", "service.worker/v1", "hostinger.vps/v1"],
		["data", "data.mysql/v1", "hostinger.mysql/v1"],
	] as const)("declares %s from the landed factories", (slot, profile, productId) => {
		const entries = slotEntries(slot);
		expect(entries.map((entry) => entry.profile)).toContain(profile);
		expect(entries.map((entry) => entry.productId)).toContain(productId);
	});

	it("holds a non-empty list per slot", () => {
		for (const entries of Object.values(HOSTINGER_DEFAULT_BINDINGS)) {
			expect(Array.isArray(entries)).toBe(true);
			expect(entries.length).toBeGreaterThan(0);
		}
	});

	/**
	 * The load-bearing honesty test. A `bucket` row would say Hostinger can
	 * allocate object storage; it cannot. An empty slot is a gap an author can
	 * see.
	 */
	it("leaves the slots Hostinger sells nothing for empty", () => {
		for (const slot of [
			"bucket",
			"kv",
			"queue",
			"topic",
			"secretRef",
		] as const) {
			expect(slotEntries(slot)).toEqual([]);
		}
	});

	it("declares every way Hostinger can host a web capability", () => {
		expect(slotEntries("web").map((entry) => entry.productId)).toEqual(
			expect.arrayContaining([
				"hostinger.vps/v1",
				"hostinger.web-hosting/v1",
				"hostinger.static-site/v1",
			]),
		);
	});

	it("files every entry under the slot the binding itself names", () => {
		for (const [slot, entries] of Object.entries(HOSTINGER_DEFAULT_BINDINGS)) {
			for (const entry of entries ?? []) {
				expect(entry.slot).toBe(slot);
			}
		}
	});

	it("names only published capability profiles", () => {
		for (const entries of Object.values(HOSTINGER_DEFAULT_BINDINGS)) {
			for (const entry of entries ?? []) {
				expect(REAL_PROFILES).toContain(entry.profile);
			}
		}
	});

	it("invents no properties on a catalog entry", () => {
		for (const entries of Object.values(HOSTINGER_DEFAULT_BINDINGS)) {
			for (const entry of entries ?? []) {
				expect(entry.properties).toEqual({});
			}
		}
	});

	it("freezes the catalog and its slot lists", () => {
		expect(Object.isFrozen(HOSTINGER_DEFAULT_BINDINGS)).toBe(true);
		for (const entries of Object.values(HOSTINGER_DEFAULT_BINDINGS)) {
			expect(Object.isFrozen(entries)).toBe(true);
		}
	});
});

describe("hostingerYardSpec emits raw, canonical rows", () => {
	it("carries the provider id and the published default data centres", () => {
		const spec = hostingerYardSpec();
		expect(spec.provider).toBe("hostinger");
		expect(spec.regions).toEqual(DEFAULT_REGIONS);
	});

	it("takes the caller's data centres without reordering them", () => {
		expect(hostingerYardSpec({ regions: ["sgp"] }).regions).toEqual(["sgp"]);
	});

	it("emits one row per catalog entry, dropping none", () => {
		const declared = Object.values(HOSTINGER_DEFAULT_BINDINGS).reduce(
			(total, entries) => total + (entries?.length ?? 0),
			0,
		);
		expect(hostingerYardSpec().bindings).toHaveLength(declared);
	});

	/**
	 * `vps()` and `vpsWorker()` emit the same productId under different
	 * profiles. Rows key on `(profile, productId, connectivityId)`, so both
	 * survive — a dedup on productId alone would silently drop one.
	 */
	it("keeps one product reached through two profiles as two rows", () => {
		const rows = hostingerYardSpec().bindings.filter(
			(row) => row.productId === "hostinger.vps/v1",
		);
		expect(rows.map((row) => row.profile).sort()).toEqual([
			"service.worker/v1",
			"web.hosted/v1",
		]);
	});

	it("sorts rows by (profile, productId, connectivityId)", () => {
		const keys = hostingerYardSpec().bindings.map(
			(row) =>
				`${row.profile} ${row.productId ?? ""} ${row.connectivityId ?? ""}`,
		);
		expect(keys).toEqual([...keys].sort());
	});

	it("carries no duplicate (profile, productId, connectivityId) triple", () => {
		const keys = hostingerYardSpec().bindings.map(
			(row) =>
				`${row.profile}|${row.productId ?? ""}|${row.connectivityId ?? ""}`,
		);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("omits the slot from a row, because rows key on the profile", () => {
		for (const row of hostingerYardSpec().bindings) {
			expect("slot" in row).toBe(false);
		}
	});

	it("is deterministic and frozen", () => {
		expect(hostingerYardSpec()).toEqual(hostingerYardSpec());
		const spec = hostingerYardSpec();
		expect(Object.isFrozen(spec)).toBe(true);
		expect(Object.isFrozen(spec.bindings)).toBe(true);
		expect(Object.isFrozen(spec.regions)).toBe(true);
	});
});
