// Promoted proofs (plan 0024 §3; AGENTS.md "Draft-proof promotion policy").
// The semantics of three frozen technical proofs are copied here as package
// tests against the production engine; the proofs themselves are untouched.
//
//   src/draft/technical-proofs/slo-promotion-gate-contract
//   src/draft/technical-proofs/error-budget-deploy-gate-contract
//   src/draft/technical-proofs/slo-as-code-contract
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	Aggregation,
	Comparator,
	EvidenceObservationRecordSchema,
	HealthSourceKind,
	VerificationSpecRecordSchema,
	VerificationVerdict,
} from "../../src/_generated/cd_pb.js";
import { CD_STREAMS } from "../../src/events.js";
import {
	createVerificationEngine,
	evaluateVerification,
	type ParsedVerificationSpec,
	parseVerificationSpec,
	qualifies,
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
	samples,
	T0,
	TENANT,
	thresholdSpec,
	unavailable,
} from "./fakes.js";

const burnSpec = (ceiling: number) =>
	thresholdSpec({
		maxErrorBudgetBurn: ceiling,
		thresholds: [
			{
				query: query("checkout.latency.burn", { unit: "burn_rate" }),
				aggregation: Aggregation.MAX,
				comparator: Comparator.LT,
				value: 1_000,
			},
		],
	});

async function verify(
	spec: ReturnType<typeof thresholdSpec>,
	answer: () => ReturnType<typeof samples>,
	suiteOk = true,
) {
	const store = new MemoryEventStore();
	const time = clock();
	const engine = createVerificationEngine({
		store,
		tenant: TENANT,
		now: time.now,
		sources: [new ScriptedHealthSource(HealthSourceKind.PROMETHEUS, answer)],
		suites: new RecordingVerifyPort(() => suiteOk),
		http: new ScriptedTransport(() => json(200, {})).transport,
	});
	const ctx = context(time.now);
	const id = await engine.start(
		{
			spec,
			freightId: fid("sha256:f1"),
			campId: camp("camp-a"),
			cohortAware: false,
		},
		ctx,
	);
	time.advance(10 * MINUTE);
	let [result] = await engine.tick(ctx);
	if (!result) {
		time.advance(20 * MINUTE);
		[result] = await engine.tick(ctx);
	}
	return { result, store, id };
}

describe("slo-promotion-gate-contract", () => {
	it("burn rate at or above the rollback threshold → FAIL (rollback)", async () => {
		const { result } = await verify(burnSpec(2), () =>
			samples([0.7, 2.5, 1.1]),
		);
		expect(result?.verdict).toBe(VerificationVerdict.FAIL);
	});

	it("within the SLO budget → PASS (promote)", async () => {
		const { result } = await verify(burnSpec(2), () =>
			samples([0.7, 0.9, 1.1]),
		);
		expect(result?.verdict).toBe(VerificationVerdict.PASS);
	});

	it("stale or unavailable burn-rate reads fail safe: never PASS", async () => {
		const { result } = await verify(burnSpec(2), unavailable);
		expect(qualifies(result?.verdict ?? VerificationVerdict.UNSPECIFIED)).toBe(
			false,
		);
	});

	it("golden-suite failure maps to FAIL", async () => {
		const spec = thresholdSpec({
			thresholds: [
				{
					query: query("ok"),
					aggregation: Aggregation.MEAN,
					comparator: Comparator.LT,
					value: 1,
				},
			],
			suites: [{ suite: "golden.default" }],
		});
		const { result } = await verify(spec, () => samples([0, 0, 0]), false);
		expect(result?.verdict).toBe(VerificationVerdict.FAIL);
		expect(
			result?.checks.find((c) => c.check === "suite:golden.default")?.reason
				?.code,
		).toBe("verification-suite-failed");
	});

	it("a fixed snapshot gives a pure, replayable verdict pinned to its inputs", async () => {
		const { store, id } = await verify(burnSpec(2), () =>
			samples([0.7, 0.9, 1.1]),
		);
		expect(await replayVerificationFromStore(store, id)).toMatchObject({
			matches: true,
		});
		expect(store.events(CD_STREAMS.verification(id))[0]?.data).toMatchObject({
			verificationId: id,
			startedAt: new Date(T0).toISOString(),
		});
	});
});

describe("error-budget-deploy-gate-contract", () => {
	it("burn above the freeze ceiling blocks (FAIL with error-budget-exhausted)", async () => {
		const { result } = await verify(burnSpec(8), () => samples([1, 9, 2]));
		expect(
			result?.checks.find((c) => c.check === "error-budget")?.reason?.code,
		).toBe("verification-error-budget-exhausted");
		expect(result?.verdict).toBe(VerificationVerdict.FAIL);
	});

	it("a healthy budget allows", async () => {
		const { result } = await verify(burnSpec(8), () => samples([1, 2, 3]));
		expect(
			result?.checks.find((c) => c.check === "error-budget")?.verdict,
		).toBe(VerificationVerdict.PASS);
	});

	it("no burn evidence is never treated as a healthy budget", async () => {
		const { result } = await verify(burnSpec(8), () => samples([]));
		expect(
			result?.checks.find((c) => c.check === "error-budget")?.reason?.code,
		).toBe("verification-no-data");
		expect(result?.verdict).toBe(VerificationVerdict.FAIL);
	});
});

describe("slo-as-code-contract", () => {
	const parsed = (
		spec: ReturnType<typeof thresholdSpec>,
	): ParsedVerificationSpec => {
		const outcome = parseVerificationSpec(spec);
		if (!outcome.ok) throw new Error("spec refused");
		return outcome.value;
	};

	it("definitions without an SLI source are rejected", () => {
		const spec = thresholdSpec({
			thresholds: [
				{
					query: query("x", { source: HealthSourceKind.UNSPECIFIED }),
					aggregation: Aggregation.MEAN,
					comparator: Comparator.LT,
					value: 1,
				},
			],
		});
		expect(parseVerificationSpec(spec).ok).toBe(false);
	});

	it("a window shorter than its sampling interval is rejected", () => {
		const spec = thresholdSpec({
			probes: [
				{
					name: "p",
					urlRef: "https://a.example.com",
					intervalMs: BigInt(20 * MINUTE),
				},
			],
		});
		const outcome = parseVerificationSpec(spec);
		expect(outcome.ok ? [] : outcome.reasons.map((r) => r.code)).toEqual([
			"verification-probe-interval-exceeds-window",
		]);
	});

	it("an ungateable objective (no checks) is flagged instead of silently passing", () => {
		expect(
			parseVerificationSpec(create(VerificationSpecRecordSchema, {})).ok,
		).toBe(false);
	});

	it("good greater than total (a ratio above 1) fails closed", () => {
		const spec = parsed(thresholdSpec());
		const evidence = [0.1, 1.2, 0.1].map((value) =>
			create(EvidenceObservationRecordSchema, {
				campId: "camp-a",
				signal: "threshold:error_rate",
				value,
				healthy: true,
				observedAt: new Date(T0).toISOString(),
				source: "t",
			}),
		);
		const result = evaluateVerification({
			spec,
			cohortAware: false,
			evidence,
			startedAtMs: T0,
			atMs: T0 + 10 * MINUTE,
		});
		expect(result.verdict).toBe(VerificationVerdict.FAIL);
	});

	it("conflicting overlapping definitions resolve deterministically: duplicate names are refused", () => {
		const spec = thresholdSpec();
		const first = spec.thresholds[0];
		if (first) spec.thresholds.push(first);
		expect(parseVerificationSpec(spec).ok).toBe(false);
	});

	it("from-zero replay reconstructs the same verdict as live folding", async () => {
		const { store, id, result } = await verify(thresholdSpec(), () =>
			samples([0.01, 0.02, 0.03]),
		);
		expect((await replayVerificationFromStore(store, id))?.replayed).toBe(
			result?.verdict,
		);
	});
});
