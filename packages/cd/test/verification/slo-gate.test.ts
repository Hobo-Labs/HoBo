import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	HealthSourceKind,
	VerificationSpecRecordSchema,
	VerificationVerdict,
} from "../../src/_generated/cd_pb.js";
import {
	createVerificationEngine,
	parseVerificationSpec,
	replayVerificationFromStore,
} from "../../src/verification/index.js";
import {
	camp,
	clock,
	context,
	fid,
	json,
	MemoryEventStore,
	MINUTE,
	query,
	RecordingVerifyPort,
	ScriptedHealthSource,
	ScriptedTransport,
	T0,
	TENANT,
} from "./fakes.js";

type Point = {
	value: number;
	observedAtMs: number;
	seriesKey: string;
	correlationKey: string;
};

function sloSpec() {
	return create(VerificationSpecRecordSchema, {
		sloGate: {
			burnRate: query("burn", {
				query: "burn",
				unit: "burn_rate",
			}),
			remainingBudgetRatio: query("budget", {
				query: "budget",
				unit: "ratio",
			}),
		},
	});
}

function point(minute: number, value: number, seriesKey = "0"): Point {
	return {
		value,
		observedAtMs: T0 + minute * MINUTE,
		seriesKey,
		correlationKey: seriesKey,
	};
}

function harness() {
	const store = new MemoryEventStore();
	const time = clock();
	const observations = {
		burn: [] as Point[],
		budget: [] as Point[],
		burnTime: undefined as Point[] | undefined,
		budgetTime: undefined as Point[] | undefined,
		burnTimeAfter: undefined as Point[] | undefined,
		budgetTimeAfter: undefined as Point[] | undefined,
	};
	let burnTimeCalls = 0;
	let budgetTimeCalls = 0;
	const source = new ScriptedHealthSource(
		HealthSourceKind.PROMETHEUS,
		(call) => {
			const sourceTimes = (points: Point[]) =>
				points.map((item) => ({ ...item, value: item.observedAtMs / 1000 }));
			let selected: Point[] = [];
			if (call.query === "burn") selected = observations.burn;
			if (call.query === "budget") selected = observations.budget;
			if (call.query === "timestamp(burn)") {
				burnTimeCalls += 1;
				selected =
					(burnTimeCalls % 2 === 0 ? observations.burnTimeAfter : undefined) ??
					observations.burnTime ??
					sourceTimes(observations.burn);
			}
			if (call.query === "timestamp(budget)") {
				budgetTimeCalls += 1;
				selected =
					(budgetTimeCalls % 2 === 0
						? observations.budgetTimeAfter
						: undefined) ??
					observations.budgetTime ??
					sourceTimes(observations.budget);
			}
			const points = selected.filter(
				(item) =>
					item.observedAtMs >= call.fromMs && item.observedAtMs <= call.toMs,
			);
			return {
				ok: true,
				value: {
					points,
					values: points.map((item) => item.value),
					fromMs: call.fromMs,
					toMs: call.toMs,
				},
			};
		},
	);
	const make = (suiteOk = true) =>
		createVerificationEngine({
			store,
			tenant: TENANT,
			now: time.now,
			sources: [source],
			suites: new RecordingVerifyPort(() => suiteOk),
			http: new ScriptedTransport(() => json(200, {})).transport,
		});
	const engine = make();
	const ctx = context(time.now);
	return { store, time, observations, source, engine, make, ctx };
}

async function start(h: ReturnType<typeof harness>, spec = sloSpec()) {
	return h.engine.start(
		{
			spec,
			freightId: fid("freight-1"),
			campId: camp("camp-a"),
			cohortAware: false,
		},
		h.ctx,
	);
}

describe("SLO rollout verification", () => {
	it("defaults to a 15 minute window and validates ordered thresholds", () => {
		const parsed = parseVerificationSpec(sloSpec());
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.windowMs).toBe(BigInt(15 * MINUTE));
		expect(parsed.value.sloGate).toMatchObject({
			rollbackBurnRate: 12,
			minRemainingBudgetRatio: 0.08,
			holdBurnRate: 1,
			holdRemainingBudgetRatio: 0.2,
			sustainedBreachCount: 2,
			sustainedHealthyCount: 2,
			maxSampleAgeMs: BigInt(10 * MINUTE),
		});
		const invalid = sloSpec();
		if (!invalid.sloGate) throw new Error("missing gate");
		invalid.sloGate.holdBurnRate = 12;
		expect(parseVerificationSpec(invalid).ok).toBe(false);
		const expression = sloSpec();
		if (!expression.sloGate?.burnRate) throw new Error("missing burn query");
		expression.sloGate.burnRate.query = "rate(burn[5m])";
		expect(parseVerificationSpec(expression).ok).toBe(false);
	});

	it("waits until both Prometheus source samples advance", async () => {
		const h = harness();
		const id = await start(h);
		h.observations.burn = [point(14, 0.1), point(15, 0.1)];
		h.observations.budget = [point(14, 0.5), point(15, 0.5)];
		h.observations.burnTime = [
			point(14, (T0 + 14 * MINUTE) / 1000),
			point(15, (T0 + 14 * MINUTE) / 1000),
		];
		h.observations.budgetTime = [
			point(14, (T0 + 14 * MINUTE) / 1000),
			point(15, (T0 + 15 * MINUTE) / 1000),
		];
		h.time.advance(15 * MINUTE);
		expect(await h.engine.tick(h.ctx)).toEqual([]);
		h.observations.burn.push(point(16, 0.1));
		h.observations.budget.push(point(16, 0.5));
		h.observations.burnTime.push(point(16, (T0 + 16 * MINUTE) / 1000));
		h.observations.budgetTime.push(point(16, (T0 + 16 * MINUTE) / 1000));
		h.time.advance(MINUTE);
		expect((await h.engine.tick(h.ctx))[0]?.verdict).toBe(
			VerificationVerdict.PASS,
		);
		expect(await replayVerificationFromStore(h.store, id)).toMatchObject({
			matches: true,
		});
	});

	it("breaks a healthy streak when either metric worsens between source samples", async () => {
		const h = harness();
		await start(h);
		h.observations.burn = [point(14, 0.1), point(15, 0.1), point(16, 0.1)];
		h.observations.budget = [point(14, 0.5), point(15, 0.08), point(16, 0.5)];
		h.observations.burnTime = [
			point(14, (T0 + 14 * MINUTE) / 1000),
			point(15, (T0 + 14 * MINUTE) / 1000),
			point(16, (T0 + 16 * MINUTE) / 1000),
		];
		h.time.advance(16 * MINUTE);
		expect(await h.engine.tick(h.ctx)).toEqual([]);
		h.observations.burn.push(point(17, 0.1));
		h.observations.budget.push(point(17, 0.5));
		h.observations.burnTime.push(point(17, (T0 + 17 * MINUTE) / 1000));
		h.time.advance(MINUTE);
		expect((await h.engine.tick(h.ctx))[0]?.verdict).toBe(
			VerificationVerdict.PASS,
		);
	});

	it("does not roll back from repeated evaluations of one source sample", async () => {
		const h = harness();
		await start(h);
		h.observations.burn = [point(14, 12), point(15, 12)];
		h.observations.budget = [point(14, 0.5), point(15, 0.5)];
		h.observations.burnTime = [
			point(14, (T0 + 14 * MINUTE) / 1000),
			point(15, (T0 + 14 * MINUTE) / 1000),
		];
		h.time.advance(15 * MINUTE);
		expect(await h.engine.tick(h.ctx)).toEqual([]);
	});

	it("holds when a timestamp query describes a different series", async () => {
		const h = harness();
		await start(h);
		h.observations.burn = [point(14, 0.1), point(15, 0.1)];
		h.observations.budget = [point(14, 0.5), point(15, 0.5)];
		h.observations.burnTime = [14, 15].map((minute) => ({
			...point(minute, (T0 + minute * MINUTE) / 1000),
			correlationKey: "another-series",
		}));
		h.time.advance(15 * MINUTE);
		expect(await h.engine.tick(h.ctx)).toEqual([]);
	});

	it("waits when a source sample changes while its metric is read", async () => {
		const h = harness();
		await start(h);
		h.observations.burn = [point(14, 0.1), point(15, 0.1)];
		h.observations.budget = [point(14, 0.5), point(15, 0.5)];
		h.observations.burnTime = [
			point(14, (T0 + 14 * MINUTE) / 1000),
			point(15, (T0 + 14 * MINUTE) / 1000),
		];
		h.observations.burnTimeAfter = [
			point(14, (T0 + 14 * MINUTE) / 1000),
			point(15, (T0 + 15 * MINUTE) / 1000),
		];
		h.time.advance(15 * MINUTE);
		expect(await h.engine.tick(h.ctx)).toEqual([]);
		h.observations.burn = [point(30, 0.1), point(31, 0.1)];
		h.observations.budget = [point(30, 0.5), point(31, 0.5)];
		h.observations.burnTime = undefined;
		h.observations.burnTimeAfter = undefined;
		h.time.advance(16 * MINUTE);
		expect((await h.engine.tick(h.ctx))[0]?.verdict).toBe(
			VerificationVerdict.PASS,
		);
	});

	it.each([
		"missing",
		"stale",
		"future",
	])("holds fresh-looking evaluations when source timestamps are %s", async (mode) => {
		const h = harness();
		await start(h);
		h.observations.burn = [point(14, 0.1), point(15, 0.1)];
		h.observations.budget = [point(14, 0.5), point(15, 0.5)];
		const sourceMinute = mode === "stale" ? 1 : 16;
		const times =
			mode === "missing"
				? []
				: [14, 15].map((minute) =>
						point(minute, (T0 + sourceMinute * MINUTE) / 1000),
					);
		h.observations.burnTime = times;
		h.observations.budgetTime = times;
		h.time.advance(15 * MINUTE);
		expect(await h.engine.tick(h.ctx)).toEqual([]);
	});

	it.each([
		{ burn: [0.2, 0.3], budget: [0.8, 0.7], verdict: VerificationVerdict.PASS },
		{ burn: [12, 12], budget: [0.8, 0.8], verdict: VerificationVerdict.FAIL },
		{
			burn: [0.2, 0.2],
			budget: [0.08, 0.08],
			verdict: VerificationVerdict.FAIL,
		},
	])("decides and replays sustained evidence %#", async ({
		burn,
		budget,
		verdict,
	}) => {
		const h = harness();
		h.observations.burn = [point(14, burn[0] ?? 0), point(15, burn[1] ?? 0)];
		h.observations.budget = [
			point(14, budget[0] ?? 0),
			point(15, budget[1] ?? 0),
		];
		const id = await start(h);
		h.time.advance(15 * MINUTE);
		const [result] = await h.engine.tick(h.ctx);
		expect(result?.verdict).toBe(verdict);
		expect(result?.evidenceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(await replayVerificationFromStore(h.store, id)).toMatchObject({
			matches: true,
			mismatches: [],
		});
	});

	it("detects a sustained slow burn sampled six minutes apart", async () => {
		const h = harness();
		await start(h);
		h.observations.burn = [point(3, 2.1), point(9, 12.4), point(15, 12.8)];
		h.observations.budget = [point(3, 0.18), point(9, 0.07), point(15, 0.06)];
		h.time.advance(15 * MINUTE);
		expect((await h.engine.tick(h.ctx))[0]?.verdict).toBe(
			VerificationVerdict.FAIL,
		);
	});

	it("waits after a transient breach until two fresh healthy samples arrive", async () => {
		const h = harness();
		await start(h);
		h.observations.burn = [point(14, 12), point(15, 0.5)];
		h.observations.budget = [point(14, 0.5), point(15, 0.5)];
		h.time.advance(15 * MINUTE);
		expect(await h.engine.tick(h.ctx)).toEqual([]);
		h.observations.burn.push(point(16, 0.5));
		h.observations.budget.push(point(16, 0.5));
		h.time.advance(MINUTE);
		expect((await h.engine.tick(h.ctx))[0]?.verdict).toBe(
			VerificationVerdict.PASS,
		);
		expect(h.source.calls.at(-1)).toMatchObject({
			fromMs: T0 + MINUTE,
			toMs: T0 + 16 * MINUTE,
		});
	});

	it.each([
		{
			name: "missing budget",
			burn: [point(14, 0.1), point(15, 0.1)],
			budget: [],
		},
		{
			name: "stale samples",
			burn: [point(1, 0.1), point(2, 0.1)],
			budget: [point(1, 0.5), point(2, 0.5)],
		},
		{
			name: "different scrape times",
			burn: [point(14, 0.1), point(15, 0.1)],
			budget: [point(13, 0.5), point(14, 0.5)],
		},
		{
			name: "distinct series",
			burn: [point(14, 0.1, "a"), point(15, 0.1, "b")],
			budget: [point(14, 0.5), point(15, 0.5)],
		},
		{
			name: "conflicting duplicates",
			burn: [point(14, 0.1), point(15, 0.1), point(15, 0.2)],
			budget: [point(14, 0.5), point(15, 0.5)],
		},
		{
			name: "missing timestamps",
			burn: [point(14, 0.1, ""), point(15, 0.1, "")],
			budget: [point(14, 0.5), point(15, 0.5)],
		},
	])("holds for $name and can recover after the deadline", async ({
		burn,
		budget,
	}) => {
		const h = harness();
		const id = await start(h);
		h.observations.burn = burn;
		h.observations.budget = budget;
		h.time.advance(15 * MINUTE);
		expect(await h.engine.tick(h.ctx)).toEqual([]);
		h.time.advance(20 * MINUTE);
		expect(await h.make().tick(h.ctx)).toEqual([]);
		h.observations.burn = [point(35, 0.1), point(36, 0.1)];
		h.observations.budget = [point(35, 0.5), point(36, 0.5)];
		h.time.advance(MINUTE);
		expect((await h.make().tick(h.ctx))[0]?.verdict).toBe(
			VerificationVerdict.PASS,
		);
		expect(await replayVerificationFromStore(h.store, id)).toMatchObject({
			matches: true,
		});
	});

	it("fails a suite even while the SLO evidence is missing", async () => {
		const h = harness();
		const spec = sloSpec();
		spec.suites.push({
			$typeName: "hobo.cd.v1.SuiteCheckRecord",
			suite: "smoke",
		});
		const engine = h.make(false);
		const id = await engine.start(
			{
				spec,
				freightId: fid("freight-1"),
				campId: camp("camp-a"),
				cohortAware: false,
			},
			h.ctx,
		);
		h.time.advance(15 * MINUTE);
		expect((await engine.tick(h.ctx))[0]?.verdict).toBe(
			VerificationVerdict.FAIL,
		);
		expect(await replayVerificationFromStore(h.store, id)).toMatchObject({
			matches: true,
		});
	});
});
