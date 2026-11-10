import { describe, expect, it } from "vitest";
import {
	claimTurn,
	fitJob,
	type MeshJob,
	type MeshNode,
	rankNodes,
} from "../src/mesh/index.js";

const NOW = 1_800_000_000_000;

const node = (id: string, overrides: Partial<MeshNode> = {}): MeshNode => ({
	id,
	freeSlots: 2,
	healthy: true,
	labels: ["hobo"],
	validUntilMs: NOW + 60_000,
	...overrides,
});

const job = (jobId: number, overrides: Partial<MeshJob> = {}): MeshJob => ({
	jobId,
	label: "hobo",
	queuedAtMs: NOW,
	...overrides,
});

const ids = (nodes: readonly MeshNode[]) => nodes.map((entry) => entry.id);
const JOBS = Array.from({ length: 6000 }, (_, index) => job(10_000 + index));

describe("rankNodes", () => {
	const mesh = [node("box-a"), node("box-b"), node("laptop"), node("arc")];

	it("gives every node the same order whatever order it heard of the others in", () => {
		const reversed = [...mesh].reverse();
		const shuffled = [mesh[2], mesh[0], mesh[3], mesh[1]].flatMap((entry) =>
			entry ? [entry] : [],
		);
		for (const each of JOBS.slice(0, 500)) {
			const order = ids(rankNodes(each, mesh, NOW));
			expect(ids(rankNodes(each, reversed, NOW))).toEqual(order);
			expect(ids(rankNodes(each, shuffled, NOW))).toEqual(order);
			expect(order).toHaveLength(4);
		}
	});

	it("leaves out a node that is unhealthy, full, stale or serves another label", () => {
		const order = rankNodes(
			job(1),
			[
				node("ok"),
				node("draining", { healthy: false }),
				node("full", { freeSlots: 0 }),
				node("stale", { validUntilMs: NOW }),
				node("other", { labels: ["hobo-trunk"] }),
				// A second advertisement for the same node counts once.
				node("ok", { freeSlots: 64 }),
			],
			NOW,
		);
		expect(ids(order)).toEqual(["ok"]);
	});

	it("gives a node first place in proportion to its free capacity", () => {
		const weighted = [
			node("small", { freeSlots: 1 }),
			node("medium", { freeSlots: 2 }),
			node("large", { freeSlots: 5 }),
		];
		const first = new Map<string, number>();
		for (const each of JOBS) {
			const winner = rankNodes(each, weighted, NOW)[0]?.id ?? "";
			first.set(winner, (first.get(winner) ?? 0) + 1);
		}
		const share = (id: string) => (first.get(id) ?? 0) / JOBS.length;
		// 1 : 2 : 5 of 8, within two points over 6000 jobs.
		expect(share("small")).toBeCloseTo(1 / 8, 1);
		expect(share("medium")).toBeCloseTo(2 / 8, 1);
		expect(share("large")).toBeCloseTo(5 / 8, 1);
		expect(Math.abs(share("large") - 5 / 8)).toBeLessThan(0.02);
	});

	it("moves only a lost node's jobs when it leaves", () => {
		const without = mesh.filter((entry) => entry.id !== "box-b");
		let moved = 0;
		for (const each of JOBS) {
			const before = ids(rankNodes(each, mesh, NOW));
			const after = ids(rankNodes(each, without, NOW));
			// The survivors keep their relative order for every job.
			expect(after).toEqual(before.filter((id) => id !== "box-b"));
			if (before[0] !== after[0]) {
				moved += 1;
				expect(before[0]).toBe("box-b");
			}
		}
		// About a quarter of the jobs had box-b first; nothing else moved.
		expect(moved / JOBS.length).toBeGreaterThan(0.2);
		expect(moved / JOBS.length).toBeLessThan(0.3);
	});
});

describe("claimTurn", () => {
	const peers = [node("box-a"), node("box-b"), node("laptop")];
	const turn = (
		selfId: string,
		each: MeshJob,
		nowMs = NOW,
		known: readonly MeshNode[] = peers,
	) =>
		claimTurn({
			job: each,
			self: known.find((entry) => entry.id === selfId) ?? node(selfId),
			peers: known,
			nowMs,
			stepMs: 20_000,
		});

	it("starts exactly one node at once and gives each of the others a later turn", () => {
		for (const each of JOBS.slice(0, 500)) {
			const turns = peers.map((entry) => turn(entry.id, each));
			expect(turns.filter((entry) => entry.start)).toHaveLength(1);
			expect(
				turns
					.flatMap((entry) => (entry.start ? [] : [entry.waitMs]))
					.sort((a, b) => a - b),
			).toEqual([20_000, 40_000]);
		}
	});

	it("starts the next node one step later when the first never does", () => {
		const each = job(42);
		const order = ids(rankNodes(each, peers, NOW));
		const second = order[1] ?? "";
		expect(turn(second, each)).toEqual({
			start: false,
			rank: 1,
			waitMs: 20_000,
			reason: "waiting-turn",
		});
		expect(turn(second, each, NOW + 19_999).start).toBe(false);
		expect(turn(second, each, NOW + 20_000)).toEqual({
			start: true,
			rank: 1,
			reason: "turn-reached",
		});
	});

	it("starts at once when the node above it is known to be full or unhealthy", () => {
		const each = job(42);
		const [first = "", second = ""] = ids(rankNodes(each, peers, NOW));
		for (const gone of [{ freeSlots: 0 }, { healthy: false }]) {
			const view = peers.map((entry) =>
				entry.id === first ? { ...entry, ...gone } : entry,
			);
			expect(turn(second, each, NOW, view)).toMatchObject({
				start: true,
				rank: 0,
			});
		}
	});

	it("starts at once when it knows of no other node", () => {
		expect(turn("box-a", job(7), NOW, [])).toEqual({
			start: true,
			rank: 0,
			reason: "alone",
		});
		// Every advertisement it holds has expired: the same as knowing no one.
		const stale = peers.map((entry) => ({ ...entry, validUntilMs: NOW - 1 }));
		expect(
			claimTurn({
				job: job(7),
				self: node("box-a", { validUntilMs: NOW - 1 }),
				peers: stale,
				nowMs: NOW,
				stepMs: 20_000,
			}),
		).toEqual({ start: true, rank: 0, reason: "alone" });
	});

	it("does not start a job it cannot run", () => {
		for (const [self, lacking] of [
			[node("box-a", { freeSlots: 0 }), "slots"],
			[node("box-a", { healthy: false }), "unhealthy"],
			[node("box-a", { labels: ["hobo-trunk"] }), "label"],
		] as const)
			expect(
				claimTurn({ job: job(7), self, peers, nowMs: NOW, stepMs: 20_000 }),
			).toEqual({
				start: false,
				rank: -1,
				waitMs: 0,
				reason: "not-eligible",
				lacking,
			});
	});

	it("bounds the wait in a large mesh", () => {
		const large = Array.from({ length: 40 }, (_, index) => node(`n${index}`));
		for (const each of JOBS.slice(0, 200)) {
			const waits = large.map((entry) => {
				const result = claimTurn({
					job: each,
					self: entry,
					peers: large,
					nowMs: NOW,
					stepMs: 20_000,
					maxRank: 3,
				});
				return result.start ? 0 : result.waitMs;
			});
			expect(Math.max(...waits)).toBe(60_000);
			expect(waits.filter((wait) => wait === 0)).toHaveLength(1);
		}
	});

	it("treats a queue time in the future as now", () => {
		const each = job(42, { queuedAtMs: NOW + 3_600_000 });
		const second = ids(rankNodes(each, peers, NOW))[1] ?? "";
		expect(turn(second, each)).toMatchObject({ start: false, waitMs: 20_000 });
	});

	it("fails over within one step whichever node is lost, even when views disagree", () => {
		// Each node knows only itself and one neighbour.
		const views = new Map([
			["box-a", [node("box-a"), node("box-b")]],
			["box-b", [node("box-b"), node("laptop")]],
			["laptop", [node("laptop"), node("box-a")]],
		]);
		const starting = (each: MeshJob, lost: string, nowMs: number) =>
			[...views]
				.filter(([id]) => id !== lost)
				.filter(([id, view]) => turn(id, each, nowMs, view).start).length;
		for (const each of JOBS.slice(0, 1000)) {
			// Nobody lost: someone starts at once. Scores are one total order,
			// so the views cannot all defer to each other in a circle.
			expect(starting(each, "", NOW)).toBeGreaterThanOrEqual(1);
			for (const lost of ["box-a", "box-b", "laptop"]) {
				// The survivors may each be waiting on the node that is gone.
				// One step later at least one of them has started.
				expect(starting(each, lost, NOW + 20_000)).toBeGreaterThanOrEqual(1);
			}
		}
	});
});

describe("fitting a job to a node", () => {
	const heavy = (jobId: number) => job(jobId, { needs: { memoryMb: 6_144 } });
	const light = (jobId: number) => job(jobId, { needs: { memoryMb: 1_024 } });

	it("counts how many copies of this job fit, and names what bounds it", () => {
		const roomy = node("roomy", { freeSlots: 4, free: { memoryMb: 32_768 } });
		const tight = node("tight", { freeSlots: 4, free: { memoryMb: 7_000 } });
		expect(fitJob(heavy(1), roomy, NOW)).toEqual({
			copies: 4,
			limitedBy: "slots",
		});
		expect(fitJob(heavy(1), tight, NOW)).toEqual({
			copies: 1,
			limitedBy: "memory",
		});
		// The same tight node has room for four of a smaller job.
		expect(fitJob(light(1), tight, NOW)).toEqual({
			copies: 4,
			limitedBy: "slots",
		});
	});

	it("says what a node lacks, most basic reason first", () => {
		const cases: [Partial<MeshNode>, MeshJob, string][] = [
			[{ validUntilMs: NOW - 1 }, heavy(1), "stale"],
			[{ healthy: false }, heavy(1), "unhealthy"],
			[{ labels: ["other"] }, heavy(1), "label"],
			[
				{ platform: { os: "linux", arch: "arm64" } },
				job(1, { needs: { arch: "x64" } }),
				"platform",
			],
			[{ freeSlots: 0, free: { memoryMb: 99_999 } }, heavy(1), "slots"],
			[{ freeSlots: 3, free: { memoryMb: 4_000 } }, heavy(1), "memory"],
			[
				{ freeSlots: 3, free: { memoryMb: 99_999, diskMb: 100 } },
				job(1, { needs: { memoryMb: 1_024, diskMb: 2_048 } }),
				"disk",
			],
		];
		for (const [overrides, each, lacking] of cases)
			expect(fitJob(each, node("n", overrides), NOW)).toEqual({
				copies: 0,
				lacking,
			});
	});

	it("treats what is not reported as unknown, not as zero", () => {
		// A node on an older version reports no memory: slots alone decide.
		expect(fitJob(heavy(1), node("old", { freeSlots: 2 }), NOW)).toEqual({
			copies: 2,
			limitedBy: "slots",
		});
		// A job with no stated needs fits any node with a slot.
		expect(fitJob(job(1), node("n", { free: { memoryMb: 1 } }), NOW)).toEqual({
			copies: 2,
			limitedBy: "slots",
		});
		// A node that does not say its platform is not ruled out by it.
		expect(
			fitJob(job(1, { needs: { arch: "x64" } }), node("n"), NOW).copies,
		).toBe(2);
	});

	it("leaves a node with a free slot but no room for this job out of the order", () => {
		const full = node("full", { freeSlots: 8, free: { memoryMb: 2_000 } });
		const fits = node("fits", { freeSlots: 1, free: { memoryMb: 8_000 } });
		for (const each of JOBS.slice(0, 300)) {
			expect(
				ids(
					rankNodes({ ...each, needs: { memoryMb: 6_144 } }, [full, fits], NOW),
				),
			).toEqual(["fits"]);
			// For a job that fits both, the node with more room for it leads more often.
			expect(
				ids(
					rankNodes({ ...each, needs: { memoryMb: 1_024 } }, [full, fits], NOW),
				).sort(),
			).toEqual(["fits", "full"]);
		}
	});

	it("shares jobs by how many of that job each node could start", () => {
		// Eight slots but memory for one heavy job, against two slots with
		// memory for two: the second node should lead about twice as often.
		const wide = node("wide", { freeSlots: 8, free: { memoryMb: 7_000 } });
		const deep = node("deep", { freeSlots: 2, free: { memoryMb: 16_000 } });
		let deepFirst = 0;
		for (const each of JOBS) {
			const order = rankNodes(
				{ ...each, needs: { memoryMb: 6_144 } },
				[wide, deep],
				NOW,
			);
			if (order[0]?.id === "deep") deepFirst++;
		}
		const share = deepFirst / JOBS.length;
		expect(share).toBeGreaterThan(0.62);
		expect(share).toBeLessThan(0.71);
	});

	it("does not wait for a node that cannot fit the job", () => {
		// `self` would rank behind `big` on slots, but `big` has no memory for
		// this job, so `self` is alone in the order and starts at once.
		const self = node("self", { freeSlots: 1, free: { memoryMb: 8_000 } });
		const big = node("big", { freeSlots: 16, free: { memoryMb: 1_000 } });
		expect(
			claimTurn({
				job: heavy(42),
				self,
				peers: [big],
				nowMs: NOW,
				stepMs: 20_000,
			}),
		).toEqual({ start: true, rank: 0, reason: "alone" });
	});

	it("tells a node why a job is not its to take", () => {
		const self = node("self", { freeSlots: 3, free: { memoryMb: 2_000 } });
		expect(
			claimTurn({
				job: heavy(42),
				self,
				peers: [],
				nowMs: NOW,
				stepMs: 20_000,
			}),
		).toEqual({
			start: false,
			rank: -1,
			waitMs: 0,
			reason: "not-eligible",
			lacking: "memory",
		});
	});
});
