import { describe, expect, it } from "vitest";
import {
	createRail,
	neutralRailDeliveryPolicy,
	parseRail,
	railFromBrokerConfig,
} from "../src/rail.js";

// WP16 (plan 0024, D14, D20): the Rail's opaque `delivery` object and the
// neutral delivery policy. Stations never interprets `delivery`; @hobo/cd
// parses it as RailDeliveryRecord.

const base = {
	id: "rail-prod",
	name: "prod",
	version: "1.0.0",
	stationId: "station-a",
	now: "2026-11-12T00:00:00.000Z",
} as const;

describe("Rail delivery object (D20)", () => {
	it("the Rail digest changes when delivery changes", () => {
		const a = createRail({ ...base, delivery: { camp_sets: ["edge"] } });
		const b = createRail({
			...base,
			delivery: { camp_sets: ["edge", "core"] },
		});
		const none = createRail(base);
		expect(a.contentHash).not.toBe(b.contentHash);
		expect(a.contentHash).not.toBe(none.contentHash);
		// Key order inside delivery is not content: the digest is canonical.
		const reordered = createRail({
			...base,
			delivery: { max_fanout_camps: 10, camp_sets: ["edge"] },
		});
		const ordered = createRail({
			...base,
			delivery: { camp_sets: ["edge"], max_fanout_camps: 10 },
		});
		expect(reordered.contentHash).toBe(ordered.contentHash);
	});

	it("parseRail passes delivery through unchanged", () => {
		const delivery = {
			rail_digest: "sha256:abc",
			camp_sets: ["edge"],
			failover: { automatic: false, max_concurrent: 1 },
			unknown_future_field: { nested: [1, "two", true, null] },
		};
		const rail = createRail({ ...base, delivery });
		const parsed = parseRail(JSON.parse(JSON.stringify(rail)));
		expect(parsed.delivery).toEqual(delivery);
		expect(parsed.contentHash).toBe(rail.contentHash);
	});

	it("legacy Rails parse unchanged (no delivery key, same digest)", () => {
		// A Rail persisted before WP16: no `delivery`, legacy delivery engine.
		const legacy = {
			schemaVersion: "hobo.rail/v1",
			id: "rail-legacy",
			name: "legacy",
			version: "1.0.0",
			contentHash:
				"sha256:1111111111111111111111111111111111111111111111111111111111111111",
			stationId: "station-a",
			activationStatus: "active",
			isBootstrap: false,
			policyPacks: ["pack-a"],
			policyEngine: { kind: "ts" },
			deliveryPolicy: { engine: "in-proc", syncMode: "auto", prune: false },
			requiredConnectorKinds: [],
			approvedProviders: ["local"],
			obligationDefaults: [],
			guardrailEnvelope: {},
			metadata: {},
			publishedAt: "2026-01-01T00:00:00.000Z",
		};
		const parsed = parseRail(legacy);
		expect("delivery" in parsed).toBe(false);
		expect(parsed.contentHash).toBe(legacy.contentHash);
		expect(parsed.id).toBe("rail-legacy");
		expect(parsed.policyPacks).toEqual(["pack-a"]);
		expect(parsed.activationStatus).toBe("active");
		expect(parsed.publishedAt).toBe(legacy.publishedAt);
	});

	it("a Rail created without delivery keeps the pre-WP16 canonical body (no delivery key)", () => {
		const rail = createRail(base);
		expect("delivery" in rail).toBe(false);
	});

	it("refuses a non-object delivery", () => {
		expect(() =>
			parseRail({ ...createRail(base), delivery: ["not", "an", "object"] }),
		).toThrow(/rail-delivery-invalid/);
	});
});

describe("neutral delivery policy (D14)", () => {
	it("defaults to a conductor reconciler with no engine vocabulary", () => {
		const rail = createRail(base);
		expect(rail.deliveryPolicy).toEqual({
			reconcilerMode: "conductor",
			syncMode: "auto",
			prune: false,
		});
		expect(JSON.stringify(rail.deliveryPolicy)).not.toMatch(/argo|in-proc/);
	});

	it("maps a legacy argo engine to the argo-cd GitOps publisher", () => {
		expect(
			neutralRailDeliveryPolicy({
				engine: "argo",
				syncMode: "manual",
				prune: true,
			}),
		).toEqual({
			reconcilerMode: "publisher",
			publisher: "argo-cd",
			syncMode: "manual",
			prune: true,
		});
		expect(
			neutralRailDeliveryPolicy({
				engine: "in-proc",
				syncMode: "auto",
				prune: false,
			}),
		).toEqual({ reconcilerMode: "conductor", syncMode: "auto", prune: false });
	});

	it("keeps a neutral policy as-is and refuses an unknown mode", () => {
		expect(
			neutralRailDeliveryPolicy({
				reconcilerMode: "publisher",
				publisher: "flux",
				syncMode: "auto",
				prune: false,
			}),
		).toEqual({
			reconcilerMode: "publisher",
			publisher: "flux",
			syncMode: "auto",
			prune: false,
		});
		expect(() =>
			neutralRailDeliveryPolicy({ reconcilerMode: "push", syncMode: "auto" }),
		).toThrow(/rail-delivery-policy-invalid/);
		expect(() =>
			neutralRailDeliveryPolicy({ reconcilerMode: "publisher" }),
		).toThrow(/publisher/);
	});

	it("imports a broker document's argo engine as a publisher", () => {
		const rail = railFromBrokerConfig("station-a", {
			brokerId: "acme",
			delivery: {
				engine: "argo",
				syncMode: "manual",
				prune: true,
				gitopsRepo: "https://git.example/r",
				destinationNamespace: "ns",
			},
		});
		expect(rail.deliveryPolicy).toEqual({
			reconcilerMode: "publisher",
			publisher: "argo-cd",
			syncMode: "manual",
			prune: true,
		});
		// destination_namespace is deprecated and never read.
		expect(JSON.stringify(rail)).not.toContain('"ns"');
	});
});
