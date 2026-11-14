// createVerificationEngine end to end over an in-memory journal: the WP9 Accept
// bullets and the §10 rows "Health source returns no data → FAIL" and
// "Canary error rate significantly worse → FAIL".
import { describe, expect, it } from "vitest";
import {
	Aggregation,
	Cohort,
	Comparator,
	HealthSourceKind,
	VerificationVerdict,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import type { HealthSource } from "../../src/ports.js";
import {
	createVerificationEngine,
	qualifies,
	replayVerification,
	replayVerificationFromStore,
} from "../../src/verification/index.js";
import {
	bodyObject,
	camp,
	clock,
	comparisonSpec,
	context,
	fid,
	json,
	MemoryEventStore,
	MINUTE,
	query,
	RecordingTelemetry,
	RecordingVerifyPort,
	ScriptedHealthSource,
	ScriptedTransport,
	samples,
	T0,
	TENANT,
	thresholdSpec,
	unavailable,
} from "./fakes.js";

const BASELINE = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109];
const WORSE = BASELINE.map((value) => value + 50);
const BETTER = BASELINE.map((value) => value - 50);

function harness(
	sources: readonly HealthSource[],
	options: { status?: number; suiteOk?: boolean } = {},
) {
	const store = new MemoryEventStore();
	const time = clock();
	const telemetry = new RecordingTelemetry();
	const http = new ScriptedTransport(() =>
		json(options.status ?? 200, { ok: true }),
	);
	const suites = new RecordingVerifyPort(() => options.suiteOk ?? true);
	const make = () =>
		createVerificationEngine({
			store,
			tenant: TENANT,
			now: time.now,
			sources,
			suites,
			http: http.transport,
			telemetry,
		});
	return {
		store,
		time,
		telemetry,
		http,
		suites,
		engine: make(),
		make,
		ctx: context(time.now),
	};
}

function latencySource(canary: readonly number[]) {
	return new ScriptedHealthSource(HealthSourceKind.PROMETHEUS, ({ cohort }) =>
		cohort === Cohort.CANARY
			? samples(canary)
			: cohort === Cohort.BASELINE
				? samples(BASELINE)
				: samples([]),
	);
}

async function expectReplayMatches(store: MemoryEventStore) {
	const ids = store
		.streamIds()
		.filter((id) => id.startsWith("cd-verification-"));
	expect(ids.length).toBeGreaterThan(0);
	for (const streamId of ids) {
		const id = streamId.slice("cd-verification-".length);
		// SAFETY: stream ids are minted by the engine from VerificationIds.
		const replay = await replayVerificationFromStore(
			store,
			id as Parameters<typeof replayVerificationFromStore>[1],
		);
		if (replay)
			expect(replay, streamId).toMatchObject({ matches: true, mismatches: [] });
	}
}

describe("verification engine: canary vs baseline", () => {
	it("canary significantly worse → FAIL, recorded with per-check outcomes and evidence", async () => {
		const source = latencySource(WORSE);
		const h = harness([source]);
		const id = await h.engine.start(
			{
				spec: comparisonSpec(),
				freightId: fid("sha256:f1"),
				campId: camp("camp-a"),
				cohortAware: true,
			},
			h.ctx,
		);
		expect(await h.engine.tick(h.ctx)).toEqual([]); // window still open
		expect(source.calls).toEqual([]);
		h.time.advance(10 * MINUTE);
		const [result] = await h.engine.tick(h.ctx);
		expect(result?.verdict).toBe(VerificationVerdict.FAIL);
		expect(result?.checks[0]?.reason?.code).toBe("verification-canary-worse");
		expect(qualifies(result?.verdict ?? VerificationVerdict.UNSPECIFIED)).toBe(
			false,
		);
		expect(
			source.calls.map((call) => [call.cohort, call.fromMs, call.toMs]),
		).toEqual([
			[Cohort.CANARY, T0, T0 + 10 * MINUTE],
			[Cohort.BASELINE, T0, T0 + 10 * MINUTE],
		]);
		const types = h.store
			.events(CD_STREAMS.verification(id))
			.map((event) => event.type);
		expect(types[0]).toBe(CD_EVENTS.VerificationStarted);
		expect(
			types.filter((type) => type === CD_EVENTS.RolloutEvidenceObserved),
		).toHaveLength(20);
		expect(types[types.length - 1]).toBe(CD_EVENTS.VerificationCompleted);
		expect(await h.engine.get(id)).toEqual(result);
		await expectReplayMatches(h.store);
	});

	it("canary significantly better → PASS", async () => {
		const h = harness([latencySource(BETTER)]);
		await h.engine.start(
			{
				spec: comparisonSpec(),
				freightId: fid("sha256:f1"),
				campId: camp("camp-a"),
				cohortAware: true,
			},
			h.ctx,
		);
		h.time.advance(10 * MINUTE);
		const [result] = await h.engine.tick(h.ctx);
		expect(result?.verdict).toBe(VerificationVerdict.PASS);
		expect(qualifies(result?.verdict ?? VerificationVerdict.UNSPECIFIED)).toBe(
			true,
		);
		await expectReplayMatches(h.store);
	});
});

describe("verification engine fails closed (I5)", () => {
	it("health source returns no data → FAIL; no qualification (§10)", async () => {
		const h = harness([
			new ScriptedHealthSource(HealthSourceKind.PROMETHEUS, () => samples([])),
		]);
		await h.engine.start(
			{
				spec: thresholdSpec(),
				freightId: fid("sha256:f1"),
				campId: camp("camp-a"),
				cohortAware: false,
			},
			h.ctx,
		);
		h.time.advance(10 * MINUTE);
		const [result] = await h.engine.tick(h.ctx);
		expect(result?.verdict).toBe(VerificationVerdict.FAIL);
		expect(result?.checks[0]?.reason?.code).toBe("verification-no-data");
		await expectReplayMatches(h.store);
	});

	it("deadline → INCONCLUSIVE, which does not qualify", async () => {
		const h = harness([
			new ScriptedHealthSource(HealthSourceKind.PROMETHEUS, () =>
				samples([0.01, 0.01]),
			),
		]);
		await h.engine.start(
			{
				spec: thresholdSpec(),
				freightId: fid("sha256:f1"),
				campId: camp("camp-a"),
				cohortAware: false,
			},
			h.ctx,
		);
		h.time.advance(10 * MINUTE);
		expect(await h.engine.tick(h.ctx)).toEqual([]);
		h.time.advance(20 * MINUTE);
		const [result] = await h.engine.tick(h.ctx);
		expect(result?.verdict).toBe(VerificationVerdict.INCONCLUSIVE);
		expect(result?.reasons.map((r) => r.code)).toContain(
			"verification-deadline-exceeded",
		);
		expect(qualifies(result?.verdict ?? VerificationVerdict.UNSPECIFIED)).toBe(
			false,
		);
		await expectReplayMatches(h.store);
	});

	it("an unavailable source is retried each tick; recovery completes on the late data", async () => {
		let down = true;
		const h = harness([
			new ScriptedHealthSource(HealthSourceKind.PROMETHEUS, () =>
				down ? unavailable() : samples([0.01, 0.02, 0.01]),
			),
		]);
		await h.engine.start(
			{
				spec: thresholdSpec(),
				freightId: fid("sha256:f1"),
				campId: camp("camp-a"),
				cohortAware: false,
			},
			h.ctx,
		);
		h.time.advance(10 * MINUTE);
		expect(await h.engine.tick(h.ctx)).toEqual([]);
		expect(
			h.telemetry.named("hobo.cd.verification.source.failures"),
		).toHaveLength(1);
		down = false;
		h.time.advance(MINUTE);
		const [result] = await h.engine.tick(h.ctx);
		expect(result?.verdict).toBe(VerificationVerdict.PASS);
		await expectReplayMatches(h.store);
	});

	it("a source that stays down fails at the deadline", async () => {
		const h = harness([
			new ScriptedHealthSource(HealthSourceKind.PROMETHEUS, () => "throw"),
		]);
		await h.engine.start(
			{
				spec: thresholdSpec(),
				freightId: fid("sha256:f1"),
				campId: camp("camp-a"),
				cohortAware: false,
			},
			h.ctx,
		);
		h.time.advance(30 * MINUTE);
		const [result] = await h.engine.tick(h.ctx);
		expect(result?.verdict).toBe(VerificationVerdict.FAIL);
		expect(result?.reasons.map((r) => r.code)).toContain(
			"verification-source-unavailable",
		);
		await expectReplayMatches(h.store);
	});

	it("an unconfigured source kind fails at window end instead of waiting", async () => {
		const h = harness([]);
		await h.engine.start(
			{
				spec: thresholdSpec(),
				freightId: fid("sha256:f1"),
				campId: camp("camp-a"),
				cohortAware: false,
			},
			h.ctx,
		);
		h.time.advance(10 * MINUTE);
		const [result] = await h.engine.tick(h.ctx);
		expect(result?.verdict).toBe(VerificationVerdict.FAIL);
		expect(result?.reasons.map((r) => r.code)).toContain(
			"health-source-unconfigured",
		);
	});

	it("a refused spec is recorded and completes FAIL at once", async () => {
		const h = harness([]);
		const id = await h.engine.start(
			{
				spec: thresholdSpec({ thresholds: [] }),
				freightId: fid("sha256:f1"),
				campId: camp("camp-a"),
				cohortAware: false,
			},
			h.ctx,
		);
		const result = await h.engine.get(id);
		expect(result?.verdict).toBe(VerificationVerdict.FAIL);
		expect(result?.reasons.map((r) => r.code)).toEqual([
			"verification-spec-empty",
		]);
		expect(await h.engine.tick(h.ctx)).toEqual([]);
		await expectReplayMatches(h.store);
	});

	it("error-budget burn above the ceiling fails (error-budget-deploy-gate semantics)", async () => {
		const spec = thresholdSpec({
			maxErrorBudgetBurn: 2,
			thresholds: [
				{
					query: query("burn", { unit: "burn_rate" }),
					aggregation: Aggregation.MAX,
					comparator: Comparator.LT,
					value: 100,
				},
			],
		});
		const h = harness([
			new ScriptedHealthSource(HealthSourceKind.PROMETHEUS, () =>
				samples([0.5, 1.5, 8]),
			),
		]);
		await h.engine.start(
			{
				spec,
				freightId: fid("sha256:f1"),
				campId: camp("camp-a"),
				cohortAware: false,
			},
			h.ctx,
		);
		h.time.advance(10 * MINUTE);
		const [result] = await h.engine.tick(h.ctx);
		expect(result?.verdict).toBe(VerificationVerdict.FAIL);
		expect(
			result?.checks.find((c) => c.check === "error-budget")?.reason?.code,
		).toBe("verification-error-budget-exhausted");
		await expectReplayMatches(h.store);
	});
});

describe("probes and suites", () => {
	const spec = () =>
		thresholdSpec({
			thresholds: [],
			probes: [
				{
					name: "health",
					urlRef: "https://api.example.com/healthz",
					intervalMs: BigInt(2 * MINUTE),
					expectStatus: 200,
				},
			],
			suites: [{ suite: "smoke" }],
		});

	it("probes fire on their interval through HttpTransport; suites run once at window end via VerifyPort", async () => {
		const h = harness([]);
		const id = await h.engine.start(
			{
				spec: spec(),
				freightId: fid("sha256:f1"),
				campId: camp("camp-a"),
				cohortAware: false,
			},
			h.ctx,
		);
		for (let minute = 0; minute < 10; minute += 1) {
			expect(await h.engine.tick(h.ctx)).toEqual([]);
			h.time.advance(MINUTE);
		}
		const [result] = await h.engine.tick(h.ctx);
		expect(result?.verdict).toBe(VerificationVerdict.PASS);
		expect(h.http.requests.map((r) => [r.method, r.url, r.timeoutMs])).toEqual(
			Array.from({ length: 5 }, () => [
				"GET",
				"https://api.example.com/healthz",
				5_000,
			]),
		);
		expect(h.suites.calls).toEqual([
			{ suite: "smoke", campId: "camp-a", freightId: "sha256:f1" },
		]);
		expect(
			h.store
				.events(CD_STREAMS.verification(id))
				.filter((e) => e.type === CD_EVENTS.RolloutEvidenceObserved),
		).toHaveLength(6);
		expect(
			h.telemetry.named("hobo.cd.verification.probe.attempts"),
		).toHaveLength(5);
		await expectReplayMatches(h.store);
	});

	it("a probe answering the wrong status fails the verification", async () => {
		const h = harness([], { status: 503 });
		const id = await h.engine.start(
			{
				spec: spec(),
				freightId: fid("sha256:f1"),
				campId: camp("camp-a"),
				cohortAware: false,
			},
			h.ctx,
		);
		for (let minute = 0; minute <= 10; minute += 2) {
			await h.engine.tick(h.ctx);
			h.time.advance(2 * MINUTE);
		}
		const result = await h.engine.get(id);
		expect(result?.verdict).toBe(VerificationVerdict.FAIL);
		expect(
			result?.checks.find((c) => c.check === "probe:health")?.reason?.code,
		).toBe("verification-probe-failed");
		await expectReplayMatches(h.store);
	});
});

describe("durability and idempotency", () => {
	it("start is idempotent while running (I12)", async () => {
		const h = harness([latencySource(BETTER)]);
		const input = {
			spec: comparisonSpec(),
			freightId: fid("sha256:f1"),
			campId: camp("camp-a"),
			cohortAware: true,
		};
		const first = await h.engine.start(input, h.ctx);
		h.time.advance(MINUTE);
		expect(await h.engine.start(input, h.ctx)).toBe(first);
		expect(h.store.streamIds()).toHaveLength(1);
	});

	it("a crash resumes from the journal: a new engine completes the running verification", async () => {
		const h = harness([latencySource(WORSE)]);
		const id = await h.engine.start(
			{
				spec: comparisonSpec(),
				freightId: fid("sha256:f1"),
				campId: camp("camp-a"),
				cohortAware: true,
			},
			h.ctx,
		);
		const restarted = h.make();
		h.time.advance(10 * MINUTE);
		const [result] = await restarted.tick(h.ctx);
		expect(result?.verificationId).toBe(id);
		expect(result?.verdict).toBe(VerificationVerdict.FAIL);
		await expectReplayMatches(h.store);
	});

	it("two engines ticking one verification complete it exactly once", async () => {
		const h = harness([latencySource(BETTER)]);
		const id = await h.engine.start(
			{
				spec: comparisonSpec(),
				freightId: fid("sha256:f1"),
				campId: camp("camp-a"),
				cohortAware: true,
			},
			h.ctx,
		);
		const other = h.make();
		h.time.advance(10 * MINUTE);
		const results = await Promise.all([
			h.engine.tick(h.ctx),
			other.tick(h.ctx),
		]);
		expect(results.flat()).toHaveLength(1);
		expect(
			h.store
				.events(CD_STREAMS.verification(id))
				.filter((e) => e.type === CD_EVENTS.VerificationCompleted),
		).toHaveLength(1);
	});

	it("replay detects a tampered journal", async () => {
		const h = harness([latencySource(WORSE)]);
		const id = await h.engine.start(
			{
				spec: comparisonSpec(),
				freightId: fid("sha256:f1"),
				campId: camp("camp-a"),
				cohortAware: true,
			},
			h.ctx,
		);
		h.time.advance(10 * MINUTE);
		await h.engine.tick(h.ctx);
		const events = [...h.store.events(CD_STREAMS.verification(id))];
		const tampered = events.map((event) => {
			const data = bodyObject(event.data);
			return event.type === CD_EVENTS.RolloutEvidenceObserved &&
				data.cohort === "COHORT_CANARY"
				? { ...event, data: { ...data, value: 1 } }
				: event;
		});
		expect(replayVerification(tampered)?.matches).toBe(false);
	});
});
