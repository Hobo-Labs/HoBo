// createVerificationEngine (D9, I5, I8, I12). Runs a VerificationSpec over its
// window against health sources, probes and verify suites, and records every
// sample it decides from on cd-verification-<id>:
//
//   start → verification.Started
//   tick  → rollout.EvidenceObserved (probes and suites as they happen; health
//           source samples together with the verdict) → verification.Completed
//
// The verdict is evaluateVerification(spec, recorded evidence, finished_at),
// so replay reproduces it exactly. A crash anywhere resumes from the journal:
// the first tick rediscovers every Started stream without a Completed event.
import { createHash } from "node:crypto";
import { create, type JsonValue, toJson } from "@bufbuild/protobuf";
import type { EventInput, HttpTransport } from "@hobo/core";
import {
	type CheckOutcomeRecord,
	Cohort,
	type EvidenceObservationRecord,
	EvidenceObservationRecordSchema,
	type HealthQueryRecord,
	HealthSourceKind,
	type ReasonRecord,
	type VerificationResultRecord,
	VerificationResultRecordSchema,
	VerificationSpecRecordSchema,
	VerificationVerdict,
} from "../_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS } from "../events.js";
import type {
	CdBase,
	CdContext,
	HealthSource,
	OtelAttributes,
	TelemetrySink,
	VerificationEngine,
	VerificationId,
	VerifyPort,
} from "../ports.js";
import { evaluateVerification, thresholdCohort } from "./evaluate.js";
import {
	evidenceBody,
	foldVerification,
	resultBody,
	startedBody,
	type VerificationState,
} from "./journal.js";
import { probeDue, runProbe } from "./probes.js";
import { reason } from "./reasons.js";
import {
	comparisonCheckId,
	type ParsedVerificationSpec,
	parseVerificationSpec,
	probeCheckId,
	suiteCheckId,
	thresholdCheckId,
} from "./spec.js";

export type VerificationEngineDeps = CdBase &
	Readonly<{
		sources: readonly HealthSource[];
		suites: VerifyPort;
		http: HttpTransport;
		/** Optional metrics sink; the journal is the record, so a failing sink never fails a tick. */
		telemetry?: TelemetrySink;
	}>;

/** Source refusals that retrying cannot fix: the check is decided as no data at once. */
const PERMANENT_SOURCE_CODES: ReadonlySet<string> = new Set([
	"health-source-unconfigured",
	"health-source-endpoint-invalid",
	"health-source-query-invalid",
	"health-source-cohort-label-missing",
]);

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function verificationId(
	input: Readonly<{
		tenant: string;
		freightId: string;
		campId: string;
		cohortAware: boolean;
		spec: JsonValue;
		atMs: number;
	}>,
): VerificationId {
	const digest = createHash("sha256")
		.update(
			JSON.stringify([
				input.tenant,
				input.freightId,
				input.campId,
				input.cohortAware,
				input.spec,
				input.atMs,
			]),
		)
		.digest("hex");
	// SAFETY: a VerificationId is any stable token; this one is content-derived.
	return `ver-${digest.slice(0, 32)}` as VerificationId;
}

type QueryPlan = Readonly<{
	check: string;
	query: HealthQueryRecord;
	cohort: Cohort;
}>;

function queryPlan(
	spec: ParsedVerificationSpec,
	cohortAware: boolean,
): readonly QueryPlan[] {
	const plans: QueryPlan[] = [];
	for (const threshold of spec.thresholds) {
		if (threshold.query)
			plans.push({
				check: thresholdCheckId(threshold.query),
				query: threshold.query,
				cohort: thresholdCohort(cohortAware),
			});
	}
	if (cohortAware) {
		for (const comparison of spec.comparisons) {
			if (!comparison.query) continue;
			const check = comparisonCheckId(comparison.query);
			plans.push(
				{ check, query: comparison.query, cohort: Cohort.CANARY },
				{ check, query: comparison.query, cohort: Cohort.BASELINE },
			);
		}
	}
	return plans;
}

export function createVerificationEngine(
	d: VerificationEngineDeps,
): VerificationEngine {
	const sources = new Map<HealthSourceKind, HealthSource>();
	for (const source of d.sources)
		if (!sources.has(source.kind)) sources.set(source.kind, source);
	const running = new Map<VerificationId, VerificationState>();
	let hydrated: Promise<void> | undefined;

	const metric = (
		name: string,
		kind: "counter" | "histogram",
		value: number,
		unit: string,
		attributes: OtelAttributes,
	) => {
		d.telemetry
			?.metrics([{ name, kind, value, unit, atMs: d.now(), attributes }])
			.catch(() => undefined);
	};
	const subject = (
		state: Pick<VerificationState, "campId" | "freightId">,
	): OtelAttributes => ({
		"hobo.camp.id": state.campId,
		"hobo.freight.id": state.freightId,
	});

	async function load(
		id: VerificationId,
	): Promise<VerificationState | undefined> {
		const events = [];
		for await (const event of d.store.read(CD_STREAMS.verification(id)))
			events.push(event);
		return foldVerification(events);
	}

	async function hydrate(): Promise<void> {
		const ids = new Set<VerificationId>();
		for await (const entry of d.store.readAll({
			tenant: d.tenant,
			filter: { type: CD_EVENTS.VerificationStarted },
		})) {
			const data = entry.event.data;
			if (
				typeof data === "object" &&
				data !== null &&
				"verificationId" in data &&
				typeof data.verificationId === "string"
			) {
				// SAFETY: read back from a Started body this engine wrote.
				ids.add(data.verificationId as VerificationId);
			}
		}
		for (const id of ids) {
			if (running.has(id)) continue;
			const state = await load(id);
			if (state && !state.result) running.set(id, state);
		}
	}

	async function append(
		state: VerificationState,
		events: EventInput[],
		ctx: CdContext,
	): Promise<void> {
		await d.store.append(CD_STREAMS.verification(state.id), events, {
			expectedSeq: state.seq,
			actor: ctx.principal,
			tenant: d.tenant,
			correlationId: state.id,
		});
	}

	function finish(
		state: VerificationState,
		atMs: number,
		verdict: VerificationVerdict,
		checks: readonly CheckOutcomeRecord[],
		reasons: readonly ReasonRecord[],
	): VerificationResultRecord {
		return create(VerificationResultRecordSchema, {
			verificationId: state.id,
			freightId: state.freightId,
			campId: state.campId,
			verdict,
			checks: [...checks],
			startedAt: iso(state.startedAtMs),
			finishedAt: iso(atMs),
			reasons: [...reasons],
		});
	}

	function completed(
		state: VerificationState,
		result: VerificationResultRecord,
	): void {
		running.delete(state.id);
		metric("hobo.cd.verification.completed", "counter", 1, "{verification}", {
			...subject(state),
			"hobo.verification.verdict": VerificationVerdict[result.verdict],
		});
		metric(
			"hobo.cd.verification.duration",
			"histogram",
			Date.parse(result.finishedAt) - state.startedAtMs,
			"ms",
			subject(state),
		);
	}

	async function advance(
		state: VerificationState,
		ctx: CdContext,
	): Promise<VerificationResultRecord | undefined> {
		const atMs = ctx.now();
		if (!state.spec) {
			const result = finish(
				state,
				atMs,
				VerificationVerdict.FAIL,
				[],
				[
					reason(
						"verification-spec-invalid",
						"the recorded spec does not parse",
					),
				],
			);
			await append(
				state,
				[{ type: CD_EVENTS.VerificationCompleted, data: resultBody(result) }],
				ctx,
			);
			completed(state, result);
			return result;
		}
		const spec = state.spec;
		const windowEndMs = state.startedAtMs + Number(spec.windowMs);
		const deadlineMs = state.startedAtMs + Number(spec.progressDeadlineMs);
		const signal = ctx.signal ?? new AbortController().signal;
		const recordedNow: EvidenceObservationRecord[] = [];

		for (const probe of spec.probes) {
			const attempts = state.evidence.filter(
				(item) => item.signal === probeCheckId(probe.name),
			);
			if (
				!probeDue({
					probe,
					attempts,
					atMs,
					windowEndMs,
					deadlineMs,
					required: spec.requiredObservations,
				})
			)
				continue;
			const observation = await runProbe(d.http, {
				probe,
				campId: state.campId,
				atMs,
			});
			recordedNow.push(observation);
			metric("hobo.cd.verification.probe.attempts", "counter", 1, "{attempt}", {
				...subject(state),
				"hobo.probe.healthy": observation.healthy,
			});
		}

		const reasons: ReasonRecord[] = [];
		const unavailable = new Set<string>();
		const sampled: EvidenceObservationRecord[] = [];
		if (atMs >= windowEndMs) {
			for (const suite of spec.suites) {
				const check = suiteCheckId(suite.suite);
				if (state.evidence.some((item) => item.signal === check)) continue;
				try {
					const outcome = await d.suites.run(
						{
							suite: suite.suite,
							campId: state.campId,
							freightId: state.freightId,
						},
						ctx,
					);
					recordedNow.push(
						create(EvidenceObservationRecordSchema, {
							campId: state.campId,
							signal: check,
							healthy: outcome.ok,
							value: outcome.ok ? 1 : 0,
							observedAt: iso(atMs),
							source: "suite",
							cohort: Cohort.ALL,
						}),
					);
					if (!outcome.ok) reasons.push(...outcome.reasons);
				} catch {
					reasons.push(
						reason(
							"verification-source-unavailable",
							`suite ${suite.suite} did not complete; retrying`,
							check,
						),
					);
				}
			}

			for (const plan of queryPlan(spec, state.cohortAware)) {
				const source = sources.get(plan.query.source);
				if (!source) {
					reasons.push(
						reason(
							"health-source-unconfigured",
							`no ${HealthSourceKind[plan.query.source]} health source is configured`,
							plan.check,
						),
					);
					continue;
				}
				let outcome: Awaited<ReturnType<HealthSource["query"]>>;
				try {
					outcome = await source.query(
						{
							query: plan.query,
							campId: state.campId,
							cohort: plan.cohort,
							fromMs: state.startedAtMs,
							toMs: windowEndMs,
							signal,
						},
						ctx,
					);
				} catch (error) {
					outcome = {
						ok: false,
						reasons: [
							reason(
								"verification-source-unavailable",
								error instanceof Error ? error.message : "health source threw",
								plan.check,
							),
						],
					};
				}
				if (!outcome.ok) {
					reasons.push(...outcome.reasons);
					const permanent = outcome.reasons.every((item) =>
						PERMANENT_SOURCE_CODES.has(item.code),
					);
					if (!permanent) unavailable.add(plan.check);
					metric(
						"hobo.cd.verification.source.failures",
						"counter",
						1,
						"{failure}",
						{
							...subject(state),
							"hobo.health_source.kind":
								HealthSourceKind[plan.query.source] ?? "UNKNOWN",
							"hobo.reason.code": outcome.reasons[0]?.code ?? "",
						},
					);
					continue;
				}
				for (const value of outcome.value.values) {
					sampled.push(
						create(EvidenceObservationRecordSchema, {
							campId: state.campId,
							signal: plan.check,
							healthy: Number.isFinite(value),
							value,
							observedAt: iso(outcome.value.toMs),
							source: HealthSourceKind[plan.query.source] ?? "",
							cohort: plan.cohort,
						}),
					);
				}
			}
		}

		const evaluation = evaluateVerification({
			spec,
			cohortAware: state.cohortAware,
			evidence: [...state.evidence, ...recordedNow, ...sampled],
			startedAtMs: state.startedAtMs,
			atMs,
			unavailable,
		});
		const evidenceEvents = (
			records: readonly EvidenceObservationRecord[],
		): EventInput[] =>
			records.map((record) => ({
				type: CD_EVENTS.RolloutEvidenceObserved,
				data: evidenceBody(record),
			}));

		if (!evaluation.complete) {
			if (recordedNow.length > 0) {
				await append(state, evidenceEvents(recordedNow), ctx);
				running.set(state.id, {
					...state,
					evidence: [...state.evidence, ...recordedNow],
					seq: state.seq + recordedNow.length,
				});
			}
			return undefined;
		}
		const extra = reasons.filter(
			(item) =>
				!evaluation.reasons.some(
					(known) => known.code === item.code && known.subject === item.subject,
				),
		);
		const result = finish(state, atMs, evaluation.verdict, evaluation.checks, [
			...evaluation.reasons,
			...extra,
		]);
		await append(
			state,
			[
				...evidenceEvents([...recordedNow, ...sampled]),
				{ type: CD_EVENTS.VerificationCompleted, data: resultBody(result) },
			],
			ctx,
		);
		completed(state, result);
		return result;
	}

	return {
		async start(input, ctx) {
			hydrated ??= hydrate();
			await hydrated;
			const parsed = parseVerificationSpec(input.spec);
			const specJson = toJson(
				VerificationSpecRecordSchema,
				parsed.ok ? parsed.value : input.spec,
			);
			for (const state of running.values()) {
				const sameSpec =
					state.spec &&
					JSON.stringify(toJson(VerificationSpecRecordSchema, state.spec)) ===
						JSON.stringify(specJson);
				if (
					state.freightId === input.freightId &&
					state.campId === input.campId &&
					state.cohortAware === input.cohortAware &&
					sameSpec
				) {
					return state.id; // I12: idempotent while running.
				}
			}
			const atMs = ctx.now();
			const id = verificationId({
				tenant: d.tenant,
				freightId: input.freightId,
				campId: input.campId,
				cohortAware: input.cohortAware,
				spec: specJson,
				atMs,
			});
			const existing = await load(id);
			if (existing) return id;
			const started: EventInput = {
				type: CD_EVENTS.VerificationStarted,
				data: startedBody({
					id,
					freightId: input.freightId,
					campId: input.campId,
					cohortAware: input.cohortAware,
					startedAtMs: atMs,
					spec: specJson,
				}),
				meta: { idempotencyKey: id },
			};
			const base: VerificationState = {
				id,
				freightId: input.freightId,
				campId: input.campId,
				cohortAware: input.cohortAware,
				spec: parsed.ok ? parsed.value : undefined,
				startedAtMs: atMs,
				evidence: [],
				result: undefined,
				seq: 0,
			};
			metric(
				"hobo.cd.verification.started",
				"counter",
				1,
				"{verification}",
				subject(base),
			);
			if (!parsed.ok) {
				// Fail closed and on the record: a refused spec completes FAIL at once.
				const result = finish(
					base,
					atMs,
					VerificationVerdict.FAIL,
					[],
					parsed.reasons,
				);
				await d.store.append(
					CD_STREAMS.verification(id),
					[
						started,
						{ type: CD_EVENTS.VerificationCompleted, data: resultBody(result) },
					],
					{
						expectedSeq: 0,
						actor: ctx.principal,
						tenant: d.tenant,
						correlationId: id,
					},
				);
				completed(base, result);
				return id;
			}
			await d.store.append(CD_STREAMS.verification(id), [started], {
				expectedSeq: 0,
				actor: ctx.principal,
				tenant: d.tenant,
				correlationId: id,
			});
			running.set(id, { ...base, seq: 1 });
			return id;
		},

		async get(id) {
			const state = running.get(id) ?? (await load(id));
			if (!state) return undefined;
			if (state.result) return state.result;
			// Still running: identity and start time, no verdict yet.
			return create(VerificationResultRecordSchema, {
				verificationId: state.id,
				freightId: state.freightId,
				campId: state.campId,
				verdict: VerificationVerdict.UNSPECIFIED,
				startedAt: iso(state.startedAtMs),
			});
		},

		async tick(ctx) {
			hydrated ??= hydrate();
			await hydrated;
			const results: VerificationResultRecord[] = [];
			for (const state of [...running.values()].sort(
				(a, b) => a.startedAtMs - b.startedAtMs || a.id.localeCompare(b.id),
			)) {
				try {
					const result = await advance(state, ctx);
					if (result) results.push(result);
				} catch {
					// Another writer moved the stream (expected-seq CAS) or the store
					// failed: drop the cache entry and resume from the journal next tick.
					running.delete(state.id);
					const fresh = await load(state.id).catch(() => undefined);
					if (fresh && !fresh.result) running.set(state.id, fresh);
				}
			}
			return results;
		},
	};
}
