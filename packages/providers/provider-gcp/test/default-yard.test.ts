import type { CapabilitySlot } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	DEFAULT_REGIONS,
	GCP_DEFAULT_BINDINGS,
	gcpYardSpec,
} from "../src/index.js";

/** Published ADR-0151 capability profiles a catalog row may name. */
const REAL_PROFILES: readonly string[] = [
	"web.static/v1",
	"web.hosted/v1",
	"web.ssr/v1",
	"api.http/v1",
	"service.worker/v1",
	"service.batch/v1",
	"service.scheduled/v1",
	"service.queue-consumer/v1",
	"data.relational/v1",
	"data.postgres/v1",
	"data.mysql/v1",
	"data.sqlite/v1",
	"data.document/v1",
	"data.vector/v1",
	"kv.key-value/v1",
	"kv.redis-compatible/v1",
	"bucket.filesystem/v1",
	"bucket.object/v1",
	"bucket.s3-compatible/v1",
	"bucket.file-storage/v1",
	"queue.at-least-once/v1",
	"queue.fifo/v1",
	"topic.pubsub/v1",
	"secret-ref.locator/v1",
	"webhook.inbound-http/v1",
];

/** Entries declared for one slot, or an empty list when the slot is absent. */
function slotEntries(slot: CapabilitySlot) {
	return GCP_DEFAULT_BINDINGS[slot] ?? [];
}

describe("the GCP Yard is an allocatable catalog, not a mapping", () => {
	it("declares three ways to host web, not one chosen for the caller", () => {
		const web = slotEntries("web");
		expect(web.length).toBeGreaterThanOrEqual(3);
		expect(web.map((entry) => entry.productId)).toEqual([
			"gcp.cloud-run/v1",
			"gcp.app-engine/v1",
			"gcp.cloud-storage-site/v1",
		]);
	});

	it.each([
		["service", 2],
		["data", 3],
	] as const)("declares %s alternatives for the %s slot", (slot, atLeast) => {
		expect(slotEntries(slot).length).toBeGreaterThanOrEqual(atLeast);
	});

	it("files every entry under the slot the binding itself names", () => {
		for (const [slot, entries] of Object.entries(GCP_DEFAULT_BINDINGS)) {
			for (const entry of entries ?? []) {
				expect(entry.slot).toBe(slot);
			}
		}
	});

	it("names only published capability profiles", () => {
		for (const entries of Object.values(GCP_DEFAULT_BINDINGS)) {
			for (const entry of entries ?? []) {
				expect(REAL_PROFILES).toContain(entry.profile);
			}
		}
	});

	it("invents no properties on a catalog entry", () => {
		for (const entries of Object.values(GCP_DEFAULT_BINDINGS)) {
			for (const entry of entries ?? []) {
				expect(entry.properties).toEqual({});
			}
		}
	});

	it("freezes the catalog and its slot lists", () => {
		expect(Object.isFrozen(GCP_DEFAULT_BINDINGS)).toBe(true);
		for (const entries of Object.values(GCP_DEFAULT_BINDINGS)) {
			expect(Object.isFrozen(entries)).toBe(true);
		}
	});
});

describe("gcpYardSpec emits raw, canonical rows", () => {
	it("carries the provider id and the published default regions", () => {
		const spec = gcpYardSpec();
		expect(spec.provider).toBe("gcp");
		expect(spec.regions).toEqual(DEFAULT_REGIONS);
	});

	it("takes the caller's regions without reordering them", () => {
		expect(gcpYardSpec({ regions: ["europe-west1"] }).regions).toEqual([
			"europe-west1",
		]);
	});

	it("emits one row per catalog entry, dropping none", () => {
		const declared = Object.values(GCP_DEFAULT_BINDINGS).reduce(
			(total, entries) => total + (entries?.length ?? 0),
			0,
		);
		expect(gcpYardSpec().bindings).toHaveLength(declared);
	});

	it("sorts rows by (profile, productId, connectivityId)", () => {
		const keys = gcpYardSpec().bindings.map(
			(row) =>
				`${row.profile} ${row.productId ?? ""} ${row.connectivityId ?? ""}`,
		);
		expect(keys).toEqual([...keys].sort());
	});

	it("carries no duplicate (profile, productId, connectivityId) triple", () => {
		const keys = gcpYardSpec().bindings.map(
			(row) =>
				`${row.profile}|${row.productId ?? ""}|${row.connectivityId ?? ""}`,
		);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("keeps both web.hosted products as separate rows", () => {
		const hosted = gcpYardSpec()
			.bindings.filter((row) => row.profile === "web.hosted/v1")
			.map((row) => row.productId);
		expect(hosted).toEqual(["gcp.app-engine/v1", "gcp.cloud-run/v1"]);
	});

	it("omits the slot from a row, because rows key on the profile", () => {
		for (const row of gcpYardSpec().bindings) {
			expect("slot" in row).toBe(false);
		}
	});

	it("is deterministic and frozen", () => {
		expect(gcpYardSpec()).toEqual(gcpYardSpec());
		const spec = gcpYardSpec();
		expect(Object.isFrozen(spec)).toBe(true);
		expect(Object.isFrozen(spec.bindings)).toBe(true);
		expect(Object.isFrozen(spec.regions)).toBe(true);
	});
});

describe("virtual machine and block storage are catalog rows", () => {
	it("registers the VM as a service worker and the disk as a filesystem volume", () => {
		const rows = Object.values(GCP_DEFAULT_BINDINGS)
			.flatMap((entries) => entries ?? [])
			.map((entry) => [entry.slot, entry.profile, entry.productId]);
		expect(rows).toContainEqual([
			"service",
			"service.worker/v1",
			"gcp.compute-engine-instance/v1",
		]);
		expect(rows).toContainEqual([
			"bucket",
			"bucket.filesystem/v1",
			"gcp.persistent-disk/v1",
		]);
		// Deliberately not a web origin row.
		expect(rows).not.toContainEqual([
			"web",
			"web.hosted/v1",
			"gcp.compute-engine-instance/v1",
		]);
	});
});
