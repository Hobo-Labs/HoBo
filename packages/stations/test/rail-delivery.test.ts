import { describe, expect, it } from "vitest";
import {
	createRail,
	neutralRailDeliveryPolicy,
	parseRail,
	railFromBrokerConfig,
} from "../src/rail.js";

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

	it("preserves the current delivery policy when parsing a Rail", () => {
		const rail = createRail({
			...base,
			deliveryPolicy: {
				reconcilerMode: "publisher",
				publisher: { target: "flux", repository: "https://git.example/rail" },
				syncMode: "manual",
				prune: true,
			},
		});
		const parsed = parseRail(JSON.parse(JSON.stringify(rail)));
		expect(parsed.deliveryPolicy).toEqual(rail.deliveryPolicy);
		expect(parsed.contentHash).toBe(rail.contentHash);
	});

	it("a Rail can omit its optional delivery object", () => {
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

	it("keeps a neutral policy as-is and refuses an unknown mode", () => {
		expect(
			neutralRailDeliveryPolicy({
				reconcilerMode: "publisher",
				publisher: { target: "flux" },
				syncMode: "auto",
				prune: false,
			}),
		).toEqual({
			reconcilerMode: "publisher",
			publisher: { target: "flux" },
			syncMode: "auto",
			prune: false,
		});
		expect(() =>
			neutralRailDeliveryPolicy({ reconcilerMode: "push", syncMode: "auto" }),
		).toThrow(/rail-delivery-policy-invalid/);
		expect(() =>
			neutralRailDeliveryPolicy({ reconcilerMode: "publisher" }),
		).toThrow(/publisher/);
		expect(() =>
			neutralRailDeliveryPolicy({
				reconcilerMode: "conductor",
				syncMode: "invalid",
			}),
		).toThrow(/syncMode/);
		expect(() =>
			neutralRailDeliveryPolicy({
				reconcilerMode: "publisher",
				publisher: { target: "flux", repository: " " },
			}),
		).toThrow(/publisher/);
	});

	it("imports a broker document's publisher policy", () => {
		const rail = railFromBrokerConfig("station-a", {
			brokerId: "acme",
			delivery: {
				reconcilerMode: "publisher",
				publisher: {
					target: "argo-cd",
					repository: "https://git.example/rail",
				},
				syncMode: "manual",
				prune: true,
			},
		});
		expect(rail.deliveryPolicy).toEqual({
			reconcilerMode: "publisher",
			publisher: { target: "argo-cd", repository: "https://git.example/rail" },
			syncMode: "manual",
			prune: true,
		});
	});
});
