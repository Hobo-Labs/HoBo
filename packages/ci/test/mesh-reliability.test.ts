import { describe, expect, it } from "vitest";
import {
	decayMeshReliability,
	MESH_MIN_RELIABILITY,
	type MeshNode,
	type MeshReliability,
	type MeshReliabilityOptions,
	meshReliabilityScore,
	meshReliabilityWeight,
	newMeshReliability,
	rankNodes,
	recordMeshOutcome,
	retractMeshDelivery,
} from "../src/mesh/index.js";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const OPTIONS: MeshReliabilityOptions = {
	halfLifeMs: 30 * MINUTE,
	priorWeight: 4,
};

function after(
	state: MeshReliability,
	outcome: "delivered" | "dropped",
	count: number,
	atMs: number,
): MeshReliability {
	let next = state;
	for (let index = 0; index < count; index += 1)
		next = recordMeshOutcome(next, outcome, atMs, OPTIONS);
	return next;
}

describe("mesh reliability score", () => {
	it("trusts a node with no history", () => {
		expect(meshReliabilityScore(newMeshReliability(NOW), NOW, OPTIONS)).toBe(1);
		// Deliveries alone never move it off 1.
		const busy = after(newMeshReliability(NOW), "delivered", 50, NOW);
		expect(meshReliabilityScore(busy, NOW, OPTIONS)).toBe(1);
	});

	it("is the share of recent jobs delivered, with the prior behind it", () => {
		// One drop on a new node: 4 imagined deliveries against 1 drop.
		const one = after(newMeshReliability(NOW), "dropped", 1, NOW);
		expect(meshReliabilityScore(one, NOW, OPTIONS)).toBeCloseTo(4 / 5, 10);
		// Half of twenty jobs dropped: (10 + 4) / (20 + 4).
		let half = after(newMeshReliability(NOW), "delivered", 10, NOW);
		half = after(half, "dropped", 10, NOW);
		expect(meshReliabilityScore(half, NOW, OPTIONS)).toBeCloseTo(14 / 24, 10);
		// Dropping many drives it down, and never to zero or below.
		const many = after(newMeshReliability(NOW), "dropped", 200, NOW);
		const score = meshReliabilityScore(many, NOW, OPTIONS);
		expect(score).toBeCloseTo(4 / 204, 10);
		expect(score).toBeGreaterThan(0);
	});

	it("recovers on its own once the drops stop", () => {
		// A disk fills and ten jobs are lost.
		const broken = after(newMeshReliability(NOW), "dropped", 10, NOW);
		const at = (minutes: number) =>
			meshReliabilityScore(broken, NOW + minutes * MINUTE, OPTIONS);
		expect(at(0)).toBeCloseTo(4 / 14, 10);
		// Each half-life halves what those drops count for.
		expect(at(30)).toBeCloseTo(4 / 9, 10);
		expect(at(60)).toBeCloseTo(4 / 6.5, 10);
		expect(at(120)).toBeCloseTo(4 / 4.625, 10);
		expect(at(180)).toBeCloseTo(4 / 4.15625, 10);
		expect(at(360)).toBeGreaterThan(0.99);
		// It only ever rises while nothing is dropped.
		let previous = at(0);
		for (let minutes = 5; minutes <= 600; minutes += 5) {
			expect(at(minutes)).toBeGreaterThan(previous);
			previous = at(minutes);
		}
	});

	it("recovers faster when jobs are delivered after the fix", () => {
		const broken = after(newMeshReliability(NOW), "dropped", 10, NOW);
		const waited = meshReliabilityScore(broken, NOW + 30 * MINUTE, OPTIONS);
		const worked = meshReliabilityScore(
			after(broken, "delivered", 10, NOW + 30 * MINUTE),
			NOW + 30 * MINUTE,
			OPTIONS,
		);
		// (10 + 4) / (10 + 5 + 4) against 4 / (5 + 4).
		expect(worked).toBeCloseTo(14 / 19, 10);
		expect(worked).toBeGreaterThan(waited + 0.25);
	});

	it("fades old deliveries too, so a long good record does not hide new drops", () => {
		const veteran = after(newMeshReliability(NOW), "delivered", 100, NOW);
		const later = NOW + 240 * MINUTE; // eight half-lives: 100 counts for 0.39
		const failing = after(veteran, "dropped", 6, later);
		expect(meshReliabilityScore(failing, later, OPTIONS)).toBeLessThan(0.45);
	});

	it("does not move when the clock steps backwards or the half-life is unset", () => {
		const state = after(newMeshReliability(NOW), "dropped", 3, NOW);
		expect(decayMeshReliability(state, NOW - MINUTE, OPTIONS)).toBe(state);
		expect(
			decayMeshReliability(state, NOW + MINUTE, {
				...OPTIONS,
				halfLifeMs: 0,
			}),
		).toBe(state);
	});

	it("takes a delivery back when the runner is lost afterwards", () => {
		const picked = after(newMeshReliability(NOW), "delivered", 1, NOW);
		// Ten minutes on the runner disappears: that job was dropped, not delivered.
		const lost = retractMeshDelivery(picked, NOW, NOW + 10 * MINUTE, OPTIONS);
		expect(lost.delivered).toBeCloseTo(0, 10);
		expect(lost.dropped).toBe(1);
		expect(
			meshReliabilityScore(lost, NOW + 10 * MINUTE, OPTIONS),
		).toBeCloseTo(4 / 5, 10);
		// Exactly what recording a drop in the first place would have given.
		const direct = recordMeshOutcome(
			newMeshReliability(NOW),
			"dropped",
			NOW + 10 * MINUTE,
			OPTIONS,
		);
		expect(lost.dropped).toBe(direct.dropped);
		expect(lost.delivered).toBeCloseTo(direct.delivered, 10);
	});
});

describe("ranking by reliability", () => {
	const node = (id: string, overrides: Partial<MeshNode> = {}): MeshNode => ({
		id,
		freeSlots: 2,
		healthy: true,
		labels: ["hobo"],
		validUntilMs: NOW + 60_000,
		...overrides,
	});
	const share = (nodes: readonly MeshNode[], id: string) => {
		const jobs = 8000;
		let first = 0;
		for (let index = 0; index < jobs; index += 1)
			if (
				rankNodes(
					{ jobId: 50_000 + index, label: "hobo", queuedAtMs: NOW },
					nodes,
					NOW,
				)[0]?.id === id
			)
				first += 1;
		return first / jobs;
	};

	it("gives a node that drops half its jobs half the share of first places", () => {
		// Equal capacity; one delivers half of what it takes.
		const mesh = [node("steady"), node("flaky", { reliability: 0.5 })];
		// Weights 2 and 1: a third of first places, not a half.
		expect(share(mesh, "flaky")).toBeGreaterThan(0.31);
		expect(share(mesh, "flaky")).toBeLessThan(0.36);
		expect(share(mesh, "steady")).toBeGreaterThan(0.64);
	});

	it("treats a node that says nothing as fully trusted", () => {
		const mesh = [node("old-version"), node("new-version", { reliability: 1 })];
		expect(share(mesh, "old-version")).toBeGreaterThan(0.47);
		expect(share(mesh, "old-version")).toBeLessThan(0.53);
	});

	it("keeps a small share for a node with a ruined record, so it can earn it back", () => {
		const mesh = [node("steady"), node("ruined", { reliability: 0.001 })];
		const ruined = share(mesh, "ruined");
		// The floor, 0.05, against 1: about one job in twenty-one.
		expect(ruined).toBeGreaterThan(0.03);
		expect(ruined).toBeLessThan(0.07);
		expect(meshReliabilityWeight(0)).toBe(MESH_MIN_RELIABILITY);
		expect(meshReliabilityWeight(0.5)).toBe(0.5);
		expect(meshReliabilityWeight(7)).toBe(1);
		expect(meshReliabilityWeight(undefined)).toBe(1);
		expect(meshReliabilityWeight(Number.NaN)).toBe(1);
	});

	it("still ranks an unreliable node when it is the only one that fits", () => {
		const mesh = [
			node("full", { freeSlots: 0 }),
			node("flaky", { reliability: 0.1 }),
		];
		expect(share(mesh, "flaky")).toBe(1);
	});

	it("combines with capacity: more room can outweigh a worse record", () => {
		// Eight copies at 0.5 is a weight of 4, against 2 at full trust.
		const mesh = [node("small"), node("large", { freeSlots: 8, reliability: 0.5 })];
		expect(share(mesh, "large")).toBeGreaterThan(0.63);
		expect(share(mesh, "large")).toBeLessThan(0.70);
	});
});
