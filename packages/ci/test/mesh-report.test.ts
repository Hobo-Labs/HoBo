import { describe, expect, it } from "vitest";
import {
	createMeshNodeTracker,
	type MeshNode,
	meshLabelStates,
	meshNodeReport,
} from "../src/mesh/index.js";

const NOW = 1_800_000_000_000;

const node = (id: string, overrides: Partial<MeshNode> = {}): MeshNode => ({
	id,
	freeSlots: 2,
	totalSlots: 4,
	healthy: true,
	labels: ["hobo"],
	validUntilMs: NOW + 45_000,
	...overrides,
});

describe("meshNodeReport", () => {
	it("reports availability, capacity, trust and reliability for a live node", () => {
		expect(
			meshNodeReport(
				node("box-a", {
					free: { memoryMb: 8_192, diskMb: 120_000 },
					platform: { os: "linux", arch: "x64" },
					labels: ["hobo", "hobo-trunk"],
					reliability: 0.875,
					samples: { delivered: 10, dropped: 2 },
					sinceMs: NOW - 60_000,
					seenAtMs: NOW - 2_000,
					trust: "trusted",
					identity: { publicKey: "KEY", signature: "SIG" },
				}),
				NOW,
			),
		).toEqual({
			id: "box-a",
			state: "live",
			sinceMs: NOW - 60_000,
			healthy: true,
			lastSeenMs: NOW - 2_000,
			validUntilMs: NOW + 45_000,
			totalSlots: 4,
			freeSlots: 2,
			freeMemoryMb: 8_192,
			freeDiskMb: 120_000,
			platform: { os: "linux", arch: "x64" },
			labels: ["hobo", "hobo-trunk"],
			trust: "trusted",
			publicKey: "KEY",
			reliability: 0.875,
			delivered: 10,
			dropped: 2,
		});
	});

	it("names a draining node unhealthy and an expired one lost, since its expiry", () => {
		expect(
			meshNodeReport(node("b", { healthy: false, sinceMs: NOW - 5_000 }), NOW),
		).toMatchObject({ state: "unhealthy", sinceMs: NOW - 5_000 });
		expect(
			meshNodeReport(
				node("c", { validUntilMs: NOW - 1_000, sinceMs: NOW - 90_000 }),
				NOW,
			),
		).toMatchObject({ state: "lost", sinceMs: NOW - 1_000 });
		// Expiring exactly now is expired, as it is for ranking.
		expect(meshNodeReport(node("d", { validUntilMs: NOW }), NOW).state).toBe(
			"lost",
		);
	});

	it("reports an older node's missing fields as unknown, and it as unverified", () => {
		const report = meshNodeReport(
			{
				id: "box-old",
				freeSlots: 3,
				healthy: true,
				labels: ["hobo"],
				validUntilMs: NOW + 1,
			},
			NOW,
		);
		expect(report).toMatchObject({
			state: "live",
			trust: "unverified",
			// No total advertised: its free slots are all that is known.
			totalSlots: 3,
			freeSlots: 3,
		});
		for (const unknown of [
			report.sinceMs,
			report.lastSeenMs,
			report.freeMemoryMb,
			report.freeDiskMb,
			report.platform,
			report.publicKey,
			report.reliability,
			report.delivered,
			report.dropped,
		])
			expect(unknown).toBeUndefined();
	});
});

describe("createMeshNodeTracker", () => {
	it("keeps a node that stopped advertising on the list as lost", () => {
		const tracker = createMeshNodeTracker({ retainLostMs: 600_000 });
		const first = tracker.observe([node("a"), node("b")], NOW);
		expect(first.nodes.map((each) => [each.id, each.state])).toEqual([
			["a", "live"],
			["b", "live"],
		]);
		expect(first.capacity).toMatchObject({ nodes: 2, freeSlots: 4 });

		// b's advertisement runs out while it is still on the board.
		const later = NOW + 46_000;
		const stale = tracker.observe(
			[node("a", { validUntilMs: later + 45_000 }), node("b")],
			later,
		);
		expect(stale.nodes.find((each) => each.id === "b")).toMatchObject({
			state: "lost",
			sinceMs: NOW + 45_000,
		});
		expect(stale.capacity).toMatchObject({ nodes: 1, freeSlots: 2 });

		// Then the board forgets it; the tracker does not.
		const gone = tracker.observe(
			[node("a", { validUntilMs: later + 90_000 })],
			later + 30_000,
		);
		expect(gone.nodes.map((each) => [each.id, each.state])).toEqual([
			["a", "live"],
			["b", "lost"],
		]);
		expect(gone.nodes[1]?.sinceMs).toBe(NOW + 45_000);
	});

	it("calls a node lost as of now when it vanishes before its advertisement ran out", () => {
		const tracker = createMeshNodeTracker();
		tracker.observe([node("a"), node("b")], NOW);
		const view = tracker.observe([node("a")], NOW + 5_000);
		expect(view.nodes.find((each) => each.id === "b")).toMatchObject({
			state: "lost",
			sinceMs: NOW + 5_000,
		});
	});

	it("lists a node as live again when it returns, and forgets a lost one in the end", () => {
		const tracker = createMeshNodeTracker({ retainLostMs: 60_000 });
		tracker.observe([node("a"), node("b")], NOW);
		tracker.observe([node("a", { validUntilMs: NOW + 200_000 })], NOW + 50_000);
		const back = tracker.observe(
			[
				node("a", { validUntilMs: NOW + 200_000 }),
				node("b", { validUntilMs: NOW + 200_000 }),
			],
			NOW + 60_000,
		);
		expect(back.nodes.map((each) => each.state)).toEqual(["live", "live"]);

		const tracker2 = createMeshNodeTracker({ retainLostMs: 60_000 });
		tracker2.observe([node("gone")], NOW);
		expect(tracker2.observe([], NOW + 60_000).nodes).toHaveLength(1);
		// Lost since its advertisement ran out at NOW + 45 s, and kept for the
		// minute of retention after that.
		expect(tracker2.observe([], NOW + 110_000).nodes).toEqual([]);
	});

	it("reports an invalid node without counting it as capacity", () => {
		const view = createMeshNodeTracker().observe(
			[node("a"), node("forged", { trust: "invalid", freeSlots: 64 })],
			NOW,
		);
		expect(view.nodes.find((each) => each.id === "forged")).toMatchObject({
			state: "live",
			trust: "invalid",
		});
		expect(view.capacity).toMatchObject({ nodes: 1, freeSlots: 2 });
	});
});

describe("meshLabelStates", () => {
	const nodes = [
		node("a", {
			labels: ["hobo", "hobo-trunk"],
			freeSlots: 2,
			trust: "trusted",
		}),
		node("b", { labels: ["hobo"], freeSlots: 3, trust: "unverified" }),
		node("unchecked", { labels: ["hobo"], freeSlots: 1 }),
		node("forged", { labels: ["hobo"], freeSlots: 64, trust: "invalid" }),
		node("draining", { labels: ["hobo"], healthy: false, trust: "trusted" }),
		node("stale", { labels: ["hobo"], validUntilMs: NOW, trust: "trusted" }),
		node("relay", {
			labels: [],
			freeSlots: 0,
			totalSlots: 0,
			trust: "trusted",
		}),
	];

	it("counts, per label, the live healthy nodes a reader ranks and their free slots", () => {
		const states = meshLabelStates(nodes, NOW, {
			labels: ["hobo", "hobo-trunk", "hobo-gpu"],
		});
		expect(Object.fromEntries(states)).toEqual({
			hobo: { nodes: 3, trustedNodes: 1, freeSlots: 6 },
			"hobo-trunk": { nodes: 1, trustedNodes: 1, freeSlots: 2 },
			// Asked for and served by nobody: said, not left out.
			"hobo-gpu": { nodes: 0, trustedNodes: 0, freeSlots: 0 },
		});
	});

	it("counts only trusted nodes when trust is required", () => {
		expect(
			Object.fromEntries(
				meshLabelStates(nodes, NOW, {
					labels: ["hobo"],
					requireTrusted: true,
				}),
			),
		).toEqual({
			hobo: { nodes: 1, trustedNodes: 1, freeSlots: 2 },
			"hobo-trunk": { nodes: 1, trustedNodes: 1, freeSlots: 2 },
		});
	});

	it("counts a node once however often it is listed or repeats a label", () => {
		expect(
			Object.fromEntries(
				meshLabelStates(
					[
						node("a", { labels: ["hobo", "hobo"], freeSlots: 2 }),
						node("a", { labels: ["hobo"], freeSlots: 9 }),
					],
					NOW,
					{ labels: ["hobo"] },
				),
			),
		).toEqual({ hobo: { nodes: 1, trustedNodes: 0, freeSlots: 2 } });
	});
});
