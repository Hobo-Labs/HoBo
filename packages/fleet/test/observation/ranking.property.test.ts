/**
 * Ranking and claim turns, moved from `packages/ci/test/mesh-rendezvous.test.ts`
 * and the ranking half of `mesh-reliability.test.ts` (design §6.8 "Ranking").
 * Every numeric property listed in `docs/design/ci-relay-mesh.md` "What the
 * tests establish" for the ranking holds here over 6,000 work digests (8,000
 * for the reliability shares, as there). The hash input is now
 * `(WorkDigest, MemberId)`; a candidate's copies come from `fitWork`.
 */
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	Health,
	ObservationSchema,
	WorkNeedsSchema,
} from "../../src/_generated/fleet_pb.js";
import {
	type MemberId,
	parseMemberId,
	parseWorkDigest,
	type WorkDigest,
} from "../../src/ids.js";
import {
	claimTurn,
	fitWork,
	rankMembers,
} from "../../src/observation/index.js";

const NOW = 1_800_000_000_000;
const STEP = 20_000;

const member = (label: string): MemberId =>
	parseMemberId(`dev_${Buffer.from(label).toString("hex").padEnd(32, "0")}`);
const digest = (index: number): WorkDigest =>
	parseWorkDigest(index.toString(16).padStart(32, "0"));
const DIGESTS = Array.from({ length: 6000 }, (_, index) =>
	digest(10_000 + index),
);

type Candidate = Readonly<{
	memberId: MemberId;
	copies: number;
	reliability: number;
}>;
const candidate = (label: string, copies = 2, reliability = 1): Candidate => ({
	memberId: member(label),
	copies,
	reliability,
});

const BOX_A = member("box-a");
const BOX_B = member("box-b");
const LAPTOP = member("laptop");
const ARC = member("arc");

function firstShares(
	candidates: readonly Candidate[],
	digests: readonly WorkDigest[] = DIGESTS,
): ReadonlyMap<MemberId, number> {
	const first = new Map<MemberId, number>();
	for (const each of digests) {
		const winner = rankMembers(each, candidates)[0];
		if (winner !== undefined) first.set(winner, (first.get(winner) ?? 0) + 1);
	}
	return new Map([...first].map(([id, count]) => [id, count / digests.length]));
}

/** `claimTurn` for `self` over the members it knows (itself included). */
function turn(
	self: MemberId,
	each: WorkDigest,
	known: readonly Candidate[],
	nowMs = NOW,
	maxRank = 4,
	queuedAtMs = NOW,
) {
	return claimTurn({
		digest: each,
		self,
		ranked: rankMembers(each, known),
		queuedAtMs,
		nowMs,
		stepMs: STEP,
		maxRank,
	});
}

describe("rankMembers", () => {
	const mesh = [
		candidate("box-a"),
		candidate("box-b"),
		candidate("laptop"),
		candidate("arc"),
	];

	it("gives every member the same order whatever order it heard of the others in", () => {
		const reversed = [...mesh].reverse();
		const shuffled = [mesh[2], mesh[0], mesh[3], mesh[1]].flatMap((entry) =>
			entry ? [entry] : [],
		);
		for (const each of DIGESTS.slice(0, 500)) {
			const order = rankMembers(each, mesh);
			expect(rankMembers(each, reversed)).toEqual(order);
			expect(rankMembers(each, shuffled)).toEqual(order);
			expect(order).toHaveLength(4);
		}
	});

	it("leaves out a member that can start no copy, and counts a repeated member once", () => {
		expect(
			rankMembers(digest(1), [
				candidate("ok"),
				candidate("full", 0),
				candidate("broken", Number.NaN),
				candidate("ok", 64),
			]),
		).toEqual([member("ok")]);
	});

	it("gives first places in proportion to capacity: 1, 2 and 5 slots take 1/8, 2/8 and 5/8 within two points", () => {
		const shares = firstShares([
			candidate("small", 1),
			candidate("medium", 2),
			candidate("large", 5),
		]);
		expect(Math.abs((shares.get(member("small")) ?? 0) - 1 / 8)).toBeLessThan(
			0.02,
		);
		expect(Math.abs((shares.get(member("medium")) ?? 0) - 2 / 8)).toBeLessThan(
			0.02,
		);
		expect(Math.abs((shares.get(member("large")) ?? 0) - 5 / 8)).toBeLessThan(
			0.02,
		);
	});

	it("moves only the quarter of work a removed member was first for; survivors keep their order", () => {
		const without = mesh.filter((entry) => entry.memberId !== BOX_B);
		let moved = 0;
		for (const each of DIGESTS) {
			const before = rankMembers(each, mesh);
			const after = rankMembers(each, without);
			expect(after).toEqual(before.filter((id) => id !== BOX_B));
			if (before[0] !== after[0]) {
				moved += 1;
				expect(before[0]).toBe(BOX_B);
			}
		}
		expect(moved / DIGESTS.length).toBeGreaterThan(0.2);
		expect(moved / DIGESTS.length).toBeLessThan(0.3);
	});

	it("depends on the work digest and the member id only", () => {
		// Renaming a member reshuffles its work; another digest gives another order.
		const orders = new Set(
			DIGESTS.slice(0, 200).map((each) => rankMembers(each, mesh).join(",")),
		);
		expect(orders.size).toBeGreaterThan(12);
	});
});

describe("claimTurn", () => {
	const peers = [candidate("box-a"), candidate("box-b"), candidate("laptop")];

	it("with complete views starts exactly one member at once; the others' turns are one and two steps away", () => {
		for (const each of DIGESTS.slice(0, 500)) {
			const turns = peers.map((entry) => turn(entry.memberId, each, peers));
			expect(turns.filter((entry) => entry.waitMs === 0)).toHaveLength(1);
			expect(turns.map((entry) => entry.waitMs).sort((a, b) => a - b)).toEqual([
				0,
				STEP,
				2 * STEP,
			]);
			expect(turns.map((entry) => entry.rank).sort()).toEqual([0, 1, 2]);
		}
	});

	it("starts the next member one step later when the first never does", () => {
		const each = digest(42);
		const second = rankMembers(each, peers)[1] ?? BOX_A;
		expect(turn(second, each, peers)).toEqual({ rank: 1, waitMs: STEP });
		expect(turn(second, each, peers, NOW + STEP - 1).waitMs).toBe(1);
		expect(turn(second, each, peers, NOW + STEP)).toEqual({
			rank: 1,
			waitMs: 0,
		});
	});

	it("starts at once when the member above it can take no copy", () => {
		const each = digest(42);
		const [first, second = BOX_A] = rankMembers(each, peers);
		const view = peers.map((entry) =>
			entry.memberId === first ? { ...entry, copies: 0 } : entry,
		);
		expect(turn(second, each, view)).toEqual({ rank: 0, waitMs: 0 });
	});

	it("starts at once when it knows of no other member", () => {
		expect(turn(BOX_A, digest(7), [candidate("box-a")])).toEqual({
			rank: 0,
			waitMs: 0,
		});
	});

	it("is never the turn of a member that is not ranked", () => {
		expect(turn(ARC, digest(7), peers)).toEqual({
			rank: -1,
			waitMs: Number.POSITIVE_INFINITY,
		});
	});

	it("with each member knowing one neighbour, someone starts at once, and after any single loss a survivor within one step", () => {
		const views = new Map<MemberId, readonly Candidate[]>([
			[BOX_A, [candidate("box-a"), candidate("box-b")]],
			[BOX_B, [candidate("box-b"), candidate("laptop")]],
			[LAPTOP, [candidate("laptop"), candidate("box-a")]],
		]);
		const starting = (
			each: WorkDigest,
			lost: MemberId | undefined,
			nowMs: number,
		) =>
			[...views]
				.filter(([id]) => id !== lost)
				.filter(([id, view]) => turn(id, each, view, nowMs).waitMs === 0)
				.length;
		for (const each of DIGESTS.slice(0, 1000)) {
			expect(starting(each, undefined, NOW)).toBeGreaterThanOrEqual(1);
			for (const lost of [BOX_A, BOX_B, LAPTOP])
				expect(starting(each, lost, NOW + STEP)).toBeGreaterThanOrEqual(1);
		}
	});

	it("in a fleet of 40 with maxRank 3, no member waits more than three steps", () => {
		const large = Array.from({ length: 40 }, (_, index) =>
			candidate(`n${index}`),
		);
		for (const each of DIGESTS.slice(0, 200)) {
			const waits = large.map(
				(entry) => turn(entry.memberId, each, large, NOW, 3).waitMs,
			);
			expect(Math.max(...waits)).toBe(3 * STEP);
			expect(waits.filter((wait) => wait === 0)).toHaveLength(1);
		}
	});

	it("treats a queue time in the future as now", () => {
		const each = digest(42);
		const second = rankMembers(each, peers)[1] ?? BOX_A;
		expect(turn(second, each, peers, NOW, 4, NOW + 3_600_000)).toEqual({
			rank: 1,
			waitMs: STEP,
		});
	});
});

describe("ranking by what fits", () => {
	const observed = (freeSlots: number, freeMemoryMb: number) =>
		create(ObservationSchema, {
			health: Health.REACHABLE,
			capacity: { freeSlots, freeMemoryMb },
		});
	const needs = (memoryMb: number) => create(WorkNeedsSchema, { memoryMb });
	const copies = (fit: ReturnType<typeof fitWork>) =>
		fit.fits ? fit.copies : 0;

	it("shares work by how many copies of it each member could start", () => {
		// Eight slots with memory for one heavy job, against two slots with memory for two.
		const wide = copies(fitWork(observed(8, 7_000), needs(6_144)));
		const deep = copies(fitWork(observed(2, 16_000), needs(6_144)));
		expect([wide, deep]).toEqual([1, 2]);
		const share =
			firstShares([candidate("wide", wide), candidate("deep", deep)]).get(
				member("deep"),
			) ?? 0;
		expect(share).toBeGreaterThan(0.62);
		expect(share).toBeLessThan(0.71);
	});

	it("leaves a member with a free slot but no room for this work out of the order", () => {
		const full = copies(fitWork(observed(8, 2_000), needs(6_144)));
		const fits = copies(fitWork(observed(1, 8_000), needs(6_144)));
		for (const each of DIGESTS.slice(0, 300))
			expect(
				rankMembers(each, [candidate("full", full), candidate("fits", fits)]),
			).toEqual([member("fits")]);
	});
});

describe("ranking by reliability", () => {
	const JOBS = Array.from({ length: 8000 }, (_, index) =>
		digest(50_000 + index),
	);
	const share = (candidates: readonly Candidate[], label: string) =>
		firstShares(candidates, JOBS).get(member(label)) ?? 0;

	it("gives a member that delivers half its work a third of first places against an equal peer", () => {
		const fleet = [candidate("steady"), candidate("flaky", 2, 0.5)];
		expect(share(fleet, "flaky")).toBeGreaterThan(0.31);
		expect(share(fleet, "flaky")).toBeLessThan(0.36);
		expect(share(fleet, "steady")).toBeGreaterThan(0.64);
	});

	it("splits evenly between a member at 1 and one whose figure is unusable", () => {
		const fleet = [
			candidate("unmeasured", 2, Number.NaN),
			candidate("measured", 2, 1),
		];
		expect(share(fleet, "unmeasured")).toBeGreaterThan(0.47);
		expect(share(fleet, "unmeasured")).toBeLessThan(0.53);
	});

	it("keeps about one job in twenty-one for a member with a ruined record", () => {
		const ruined = share(
			[candidate("steady"), candidate("ruined", 2, 0.001)],
			"ruined",
		);
		expect(ruined).toBeGreaterThan(0.03);
		expect(ruined).toBeLessThan(0.07);
	});

	it("still ranks an unreliable member when it is the only one that fits", () => {
		expect(
			share([candidate("full", 0), candidate("flaky", 2, 0.1)], "flaky"),
		).toBe(1);
	});

	it("combines with capacity: more room can outweigh a worse record", () => {
		const large = share(
			[candidate("small"), candidate("large", 8, 0.5)],
			"large",
		);
		expect(large).toBeGreaterThan(0.63);
		expect(large).toBeLessThan(0.7);
	});
});
