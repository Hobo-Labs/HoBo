// WP19 Accept: "DORA metrics match hand-computed fixtures". The fixture below
// is computed by hand in the comments; the same facts are checked through the
// pure definition and end-to-end from the journal through createCdTelemetry.
import { describe, expect, it } from "vitest";
import { FreightSubject } from "../../src/_generated/cd_pb.js";
import type { CampId } from "../../src/ports.js";
import {
	computeDora,
	computeReconcileLag,
	createCdTelemetry,
	createDoraProjection,
	DAY_MS,
	p50,
} from "../../src/telemetry/index.js";
import {
	camp,
	clock,
	context,
	DAY,
	HOUR,
	MemoryEventStore,
	MINUTE,
	T0,
	TENANT,
} from "../authz/memory-store.js";
import {
	converged,
	desiredSet,
	type Journal,
	promoted,
	recordFreight,
	requestPromotion,
	rolledBack,
} from "./journal.js";

// Hand-computed fixture (now = T0 + 7d, window 7d → (T0, T0+7d]):
//   F0 recorded T0−10d; P0 F0→prod-1 at T0−1d       (outside the window)
//   F1 recorded T0;     P1 F1→prod-1 at T0+2h        lead 2h
//   F2 recorded T0+1d;  P2 F2→prod-1 at T0+1d+3h     lead 3h, rolled back at +1h → failure, restore 1h
//   F3 recorded T0+2d;  P3 F3→prod-1 at T0+2d+5h     lead 5h
//                       P4 F3→prod-2 at T0+2d+6h     lead 6h, rolled back at +30m → failure, restore 30m
//   F4 recorded T0+3d;  P5 F4→prod-2 at T0+3d+12h    lead 12h
//   Rail promotion R1 → staging at T0+4d              (excluded: not a Bindle deployment)
// All Camps: 5 deployments → 5/7 per day; lead p50 = 3rd of [2,3,5,6,12]h = 5h;
//            CFR 2/5 = 0.4; restore p50 = 1st of [30m, 1h] = 30m.
// prod-1:    3 deployments → 3/7 per day; lead p50 = 2nd of [2,3,5]h = 3h;
//            CFR 1/3; restore p50 = 1h.
const NOW = T0 + 7 * DAY;
const EXPECTED_ALL = {
	windowMs: 7 * DAY,
	deploymentFrequencyPerDay: 5 / 7,
	leadTimeMsP50: 5 * HOUR,
	changeFailureRate: 0.4,
	timeToRestoreMsP50: 30 * MINUTE,
};
const EXPECTED_PROD1 = {
	windowMs: 7 * DAY,
	deploymentFrequencyPerDay: 3 / 7,
	leadTimeMsP50: 3 * HOUR,
	changeFailureRate: 1 / 3,
	timeToRestoreMsP50: HOUR,
};

async function fixture(): Promise<Journal> {
	const c = clock();
	const j: Journal = { store: new MemoryEventStore(c.now), clock: c };
	const promote = async (
		atMs: number,
		promotionId: string,
		freightId: string,
		campId: string,
	) => {
		const p = {
			promotionId,
			freightId,
			targets: [campId],
			pipeline: "web",
			node: campId,
		};
		await requestPromotion(j, atMs - MINUTE, p);
		await promoted(j, atMs, p, campId);
	};
	await recordFreight(j, T0 - 10 * DAY, "sha256:f0");
	await promote(T0 - DAY, "p0", "sha256:f0", "prod-1");
	await recordFreight(j, T0, "sha256:f1");
	await promote(T0 + 2 * HOUR, "p1", "sha256:f1", "prod-1");
	await recordFreight(j, T0 + DAY, "sha256:f2");
	await promote(T0 + DAY + 3 * HOUR, "p2", "sha256:f2", "prod-1");
	await rolledBack(
		j,
		T0 + DAY + 4 * HOUR,
		"rollback_p2",
		"sha256:f1",
		"prod-1",
	);
	await recordFreight(j, T0 + 2 * DAY, "sha256:f3");
	await promote(T0 + 2 * DAY + 5 * HOUR, "p3", "sha256:f3", "prod-1");
	await promote(T0 + 2 * DAY + 6 * HOUR, "p4", "sha256:f3", "prod-2");
	await rolledBack(
		j,
		T0 + 2 * DAY + 6 * HOUR + 30 * MINUTE,
		"rollback_p4",
		"sha256:f2",
		"prod-2",
	);
	await recordFreight(j, T0 + 3 * DAY, "sha256:f4");
	await promote(T0 + 3 * DAY + 12 * HOUR, "p5", "sha256:f4", "prod-2");
	const rail = {
		promotionId: "r1",
		freightId: "sha256:rail",
		targets: ["staging"],
		subject: FreightSubject.RAIL,
	};
	await requestPromotion(j, T0 + 4 * DAY - MINUTE, rail);
	await promoted(j, T0 + 4 * DAY, rail, "staging");
	j.clock.set(NOW);
	return j;
}

describe("DORA four keys", () => {
	it("match the hand-computed fixture from the journal (all Camps)", async () => {
		const j = await fixture();
		const telemetry = createCdTelemetry({
			store: j.store,
			tenant: TENANT,
			now: j.clock.now,
		});
		expect(
			await telemetry.dora({ windowMs: 7 * DAY }, context(j.clock.now)),
		).toEqual(EXPECTED_ALL);
	});

	it("match the hand-computed fixture for one Camp", async () => {
		const j = await fixture();
		const telemetry = createCdTelemetry({
			store: j.store,
			tenant: TENANT,
			now: j.clock.now,
		});
		expect(
			await telemetry.dora(
				{ windowMs: 7 * DAY, campIds: [camp("prod-1")] },
				context(j.clock.now),
			),
		).toEqual(EXPECTED_PROD1);
	});

	it("respect the (now − window, now] boundary", async () => {
		const j = await fixture();
		const telemetry = createCdTelemetry({
			store: j.store,
			tenant: TENANT,
			now: j.clock.now,
		});
		const at = T0 + 3 * DAY + 12 * HOUR;
		// Window (T0+2d+12h, T0+3d+12h]: only P5 (exactly at `now`, inclusive).
		expect(
			await telemetry.dora(
				{ windowMs: DAY },
				context(() => at),
			),
		).toEqual({
			windowMs: DAY,
			deploymentFrequencyPerDay: 1,
			leadTimeMsP50: 12 * HOUR,
			changeFailureRate: 0,
			timeToRestoreMsP50: 0,
		});
	});

	it("report zeros, never NaN, with no deployments", async () => {
		const store = new MemoryEventStore();
		const telemetry = createCdTelemetry({
			store,
			tenant: TENANT,
			now: () => T0,
		});
		expect(
			await telemetry.dora(
				{ windowMs: DAY },
				context(() => T0),
			),
		).toEqual({
			windowMs: DAY,
			deploymentFrequencyPerDay: 0,
			leadTimeMsP50: 0,
			changeFailureRate: 0,
			timeToRestoreMsP50: 0,
		});
	});

	it("the projection catches up incrementally and replays to the same answer (I8)", async () => {
		const j = await fixture();
		const projection = createDoraProjection(j.store, TENANT);
		const first = await projection.refresh();
		expect(first).toBe(j.store.all.length);
		expect(await projection.refresh()).toBe(0);
		const live = computeDora(projection.facts(), {
			windowMs: 7 * DAY,
			nowMs: NOW,
		});
		const replay = createDoraProjection(j.store, TENANT);
		await replay.refresh();
		expect(
			computeDora(replay.facts(), { windowMs: 7 * DAY, nowMs: NOW }),
		).toEqual(live);
		expect(live).toEqual(EXPECTED_ALL);
	});

	it("ignores other tenants' events", async () => {
		const j = await fixture();
		const other = createDoraProjection(j.store, "other-tenant");
		await other.refresh();
		expect(other.facts().deployments).toHaveLength(0);
	});

	it("refuses a query for another tenant", async () => {
		const j = await fixture();
		const telemetry = createCdTelemetry({
			store: j.store,
			tenant: TENANT,
			now: j.clock.now,
		});
		await expect(
			telemetry.dora(
				{ windowMs: DAY },
				{ ...context(j.clock.now), tenant: "other" },
			),
		).rejects.toMatchObject({ code: "telemetry-tenant-mismatch" });
	});

	it("p50 is the nearest-rank median", () => {
		expect(p50([])).toBe(0);
		expect(p50([7])).toBe(7);
		expect(p50([4, 1])).toBe(1);
		expect(p50([5, 1, 3])).toBe(3);
		expect(p50([4, 3, 2, 1])).toBe(2);
	});

	it("the pure definition matches the same hand-computed numbers", () => {
		const facts = {
			deployments: [
				{ promotionId: "a", campId: "c", freightId: "f1", atMs: 2 * HOUR },
				{ promotionId: "b", campId: "c", freightId: "f2", atMs: 5 * HOUR },
			],
			rollbacks: [{ campId: "c", atMs: 6 * HOUR }],
			recordedAtMs: new Map([
				["f1", 0],
				["f2", 4 * HOUR],
			]),
		};
		expect(computeDora(facts, { windowMs: DAY_MS, nowMs: DAY_MS })).toEqual({
			windowMs: DAY_MS,
			deploymentFrequencyPerDay: 2,
			leadTimeMsP50: HOUR,
			changeFailureRate: 0.5,
			timeToRestoreMsP50: HOUR,
		});
	});
});

describe("reconcile lag", () => {
	it("is the time from the latest desired Set to its convergence, or to now", async () => {
		const c = clock();
		const j: Journal = { store: new MemoryEventStore(c.now), clock: c };
		await desiredSet(j, T0, "prod-1", "set-1");
		await converged(j, T0 + 40_000, "prod-1", "set-1");
		const telemetry = createCdTelemetry({
			store: j.store,
			tenant: TENANT,
			now: c.now,
		});
		const prod1: CampId = camp("prod-1");
		expect(
			await telemetry.reconcileLagMs(
				prod1,
				context(() => T0 + 60_000),
			),
		).toBe(40_000);
		await desiredSet(j, T0 + 100_000, "prod-1", "set-2");
		// A late observation of the old Set does not count as converging set-2.
		await converged(j, T0 + 110_000, "prod-1", "set-1");
		expect(
			await telemetry.reconcileLagMs(
				prod1,
				context(() => T0 + 130_000),
			),
		).toBe(30_000);
		await converged(j, T0 + 145_000, "prod-1", "set-2");
		expect(
			await telemetry.reconcileLagMs(
				prod1,
				context(() => T0 + 200_000),
			),
		).toBe(45_000);
		expect(
			await telemetry.reconcileLagMs(camp("nowhere"), context(c.now)),
		).toBeUndefined();
	});

	it("computeReconcileLag is pure over recorded marks", () => {
		expect(computeReconcileLag([], [], 10)).toBeUndefined();
		expect(computeReconcileLag([{ setId: "s", atMs: 0 }], [], 10)).toBe(10);
	});
});
