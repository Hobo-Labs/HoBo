// createRolloutOrchestrator (C3, C4, C5, D7, D8, D12). Drives one promotion's
// exposure Camp by Camp and stage by stage, deciding only from the journal and
// from observation:
//
//   plan   lower the strategy per Camp onto its traffic rungs (rollout.Lowered)
//   run    start the staged OpenDeliveryEngine record (the one ramp machine)
//   tick   per (Camp, stage): reserve canary capacity → wait for the reconciler
//          to report the promoted Set CONVERGED → boundary checks (windows,
//          experiment, approval) → record the shift intent → Station cutover →
//          observe the split → verification → advance the engine
//
// Every external effect is preceded by a CAS append of its intent, so a crash
// resumes by observation and two drivers can never both shift (I4, I5, I12).
// A FAIL, an INCONCLUSIVE verdict, a passed progress deadline, a rejected
// experiment or a denied approval rolls back per D12: zero exposure through
// Station cutover, then a rollback Delta to the predecessor Set that the
// promotion gate decides (I7). No default ever passes on absent evidence.
import { createHash } from "node:crypto";
import { create, type JsonValue, toJson } from "@bufbuild/protobuf";
import {
	DELTA_SCHEMA,
	CD_DEFAULTS,
	CD_EVENTS,
	WINDOW_CLOSED,
} from "../events.js";
import {
	DeltaRecordSchema,
	type ObligationRef,
	type PromotionRecord,
	type ReasonRecord,
	ReconcileStatus,
	type RolloutPlanRecord,
	RolloutPlanRecordSchema,
	RolloutStrategy,
	type VerificationResultRecord,
	VerificationResultRecordSchema,
	type VerificationSpecRecord,
	VerificationSpecRecordSchema,
	VerificationVerdict,
} from "../_generated/cd_pb.js";
import type {
	ApprovalPort,
	CampId,
	CdBase,
	CdContext,
	ChangeWindows,
	DeltaId,
	DeltaLedger,
	DesiredStateReader,
	FreightId,
	OtelAttributes,
	Outcome,
	RolloutEngine,
	RolloutId,
	RolloutOrchestrator,
	RolloutSnapshot,
	RolloutStatus,
	SetId,
	TelemetrySink,
	TopologyReader,
	TrafficShifter,
	VerificationEngine,
} from "../ports.js";
import type { CanaryCapacity } from "./capacity.js";
import {
	bodies,
	type CampStageState,
	foldRollout,
	loweredBody,
	ROLLOUT_LEDGER,
	type RolloutLedgerState,
	asCamp,
	asVerification,
	stageKey,
} from "./journal.js";
import { canonicalJson, isJsonObject, jsonOf } from "./json.js";
import {
	cohortAware,
	effectiveStrategy,
	hasObligation,
	lowerCamp,
	needsTraffic,
	ROLLOUT_OBLIGATIONS,
	stagePercentsFor,
} from "./lowering.js";
import { reason, refuse, type RolloutReasonCode } from "./reasons.js";
import { stagePlanId, stageRoutingPlan } from "./routing.js";

export type ExperimentVerdict = "ship" | "do-not-ship" | "inconclusive";

/** Where experiment conclusions come from (OpenExperimentEngine `experiment.Concluded`). */
export interface ExperimentConclusions {
	conclusion(experimentId: string): Promise<ExperimentVerdict | undefined>;
}

export type RolloutOrchestratorDeps = CdBase &
	Readonly<{
		engine: RolloutEngine;
		traffic: TrafficShifter;
		verification: VerificationEngine;
		windows: ChangeWindows;
		desired: DesiredStateReader & DeltaLedger;
		approvals: ApprovalPort;
		telemetry: TelemetrySink;
		/** Camp labels and env type for window selectors; absent means no labels. */
		topology?: TopologyReader;
		/** Canary capacity through the hosting budget authority. */
		capacity?: CanaryCapacity;
		/** Defaults to reading `experiment.Concluded` events from the store. */
		experiments?: ExperimentConclusions;
	}>;

type StepResult = "progressed" | "waiting";

const MAX_STEPS_PER_DRIVE = 64;
const EXPERIMENT_CONCLUDED = "experiment.Concluded";

function digest(value: JsonValue): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function progressDeadlineMs(spec: VerificationSpecRecord | undefined): number {
	const declared = Number(spec?.progressDeadlineMs ?? 0n);
	return declared > 0 ? declared : CD_DEFAULTS.verificationProgressDeadlineMs;
}

function holdStatus(hold: ReasonRecord): RolloutStatus {
	if (hold.code === WINDOW_CLOSED || hold.code === "rollout-rollback-window-closed")
		return "awaiting-window";
	if (hold.code === "rollout-approval-pending") return "awaiting-approval";
	return "running";
}

/** Store-backed experiment conclusions: the latest `experiment.Concluded` for the experiment. */
export function storeExperimentConclusions(d: CdBase): ExperimentConclusions {
	return {
		async conclusion(experimentId) {
			let verdict: ExperimentVerdict | undefined;
			for await (const entry of d.store.readAll({
				tenant: d.tenant,
				filter: { type: EXPERIMENT_CONCLUDED },
			})) {
				const body = jsonOf(entry.event.data);
				if (!isJsonObject(body) || body.experiment !== experimentId) continue;
				const value = body.verdict;
				if (value === "ship" || value === "do-not-ship" || value === "inconclusive") verdict = value;
			}
			return verdict;
		},
	};
}

export function rolloutIdFor(
	input: Readonly<{
		tenant: string;
		promotion: PromotionRecord;
		strategy: RolloutStrategy;
		stagePercents: readonly number[];
		verification: VerificationSpecRecord;
		windows: readonly string[];
		obligations: readonly ObligationRef[];
		offerings: readonly (readonly string[])[];
	}>,
): RolloutId {
	const hash = digest({
		tenant: input.tenant,
		promotionId: input.promotion.promotionId,
		freightId: input.promotion.freightId,
		targets: [...input.promotion.targetCampIds],
		strategy: input.strategy,
		stages: [...input.stagePercents],
		verification: toJson(VerificationSpecRecordSchema, input.verification),
		windows: [...input.windows],
		obligations: input.obligations.map((o) => `${o.kind}:${o.id}:${o.satisfied}`),
		offerings: input.offerings.map((list) => [...list].sort()),
	});
	// SAFETY: a RolloutId is any stable token; this one is content-derived.
	return `rollout-${hash.slice(0, 32)}` as RolloutId;
}

export function createRolloutOrchestrator(d: RolloutOrchestratorDeps): RolloutOrchestrator {
	const experiments = d.experiments ?? storeExperimentConclusions(d);
	const locks = new Map<string, Promise<void>>();

	// ── telemetry (the journal is the record: a failing sink never fails a step) ──
	const metric = (name: string, kind: "counter" | "histogram", value: number, unit: string, attributes: OtelAttributes) => {
		d.telemetry.metrics([{ name, kind, value, unit, atMs: d.now(), attributes }]).catch(() => undefined);
	};

	async function load(rolloutId: RolloutId): Promise<RolloutLedgerState | undefined> {
		const events = [];
		for await (const event of d.store.read(ROLLOUT_LEDGER.stream(rolloutId))) events.push(event);
		return foldRollout(rolloutId, events);
	}

	async function append(
		state: RolloutLedgerState,
		type: string,
		data: JsonValue,
		ctx: CdContext,
	): Promise<RolloutLedgerState> {
		await d.store.append(ROLLOUT_LEDGER.stream(state.rolloutId), [{ type, data }], {
			expectedSeq: state.seq,
			actor: ctx.principal,
			tenant: d.tenant,
		});
		const next = await load(state.rolloutId);
		if (!next) throw new Error(`rollout ledger vanished: ${state.rolloutId}`);
		return next;
	}

	async function exclusive<T>(rolloutId: string, fn: () => Promise<T>): Promise<T> {
		const previous = locks.get(rolloutId) ?? Promise.resolve();
		let release = (): void => undefined;
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});
		locks.set(rolloutId, next);
		await previous;
		try {
			return await fn();
		} finally {
			release();
			if (locks.get(rolloutId) === next) locks.delete(rolloutId);
		}
	}

	const attrs = (state: RolloutLedgerState, extra: OtelAttributes = {}): OtelAttributes => ({
		"hobo.rollout.id": state.rolloutId,
		"hobo.promotion.id": state.plan.promotionId,
		"hobo.rollout.strategy": RolloutStrategy[state.plan.strategy] ?? "UNSPECIFIED",
		...extra,
	});

	// ── snapshot ──────────────────────────────────────────────────────────────
	async function snapshotOf(state: RolloutLedgerState): Promise<RolloutSnapshot> {
		const engine = state.startedAtMs === undefined ? undefined : await d.engine.get(state.rolloutId);
		const stageIndex = engine?.stageIndex ?? 0;
		const exposure = Math.max(0, ...state.exposure.values());
		if (state.finished)
			return {
				rolloutId: state.rolloutId,
				status: state.finished.status,
				stageIndex,
				percent: state.finished.status === "promoted" ? 100 : state.finished.status === "rolled-back" ? 0 : exposure,
				reasons: state.finished.reasons,
			};
		if (state.refused)
			return {
				rolloutId: state.rolloutId,
				status: "failed",
				stageIndex: 0,
				percent: 0,
				reasons: state.plan.lowerings.flatMap((l) => (l.refusal ? [l.refusal] : [])),
			};
		if (state.rollback)
			return {
				rolloutId: state.rolloutId,
				status: state.hold ? holdStatus(state.hold) : "halted",
				stageIndex,
				percent: exposure,
				reasons: state.hold ? [state.rollback.reason, state.hold] : [state.rollback.reason],
			};
		if (state.hold)
			return { rolloutId: state.rolloutId, status: holdStatus(state.hold), stageIndex, percent: exposure, reasons: [state.hold] };
		const status: RolloutStatus =
			!engine || engine.status === "awaiting-window" || engine.status === "awaiting-approval" ? "running" : engine.status;
		return { rolloutId: state.rolloutId, status, stageIndex, percent: exposure, reasons: engine?.reasons ?? [] };
	}

	function unknownSnapshot(rolloutId: RolloutId, code: RolloutReasonCode, message: string): RolloutSnapshot {
		return { rolloutId, status: "failed", stageIndex: 0, percent: 0, reasons: [reason(code, message, rolloutId)] };
	}

	// ── rollback (D12) ────────────────────────────────────────────────────────
	async function beginRollback(
		state: RolloutLedgerState,
		why: ReasonRecord,
		ctx: CdContext,
	): Promise<RolloutLedgerState> {
		if (state.rollback || state.finished) return state;
		const next = await append(state, ROLLOUT_LEDGER.rollbackStarted, bodies.rollbackStarted(why, ctx.now()), ctx);
		metric("hobo.cd.rollout.rollbacks", "counter", 1, "{rollback}", attrs(state, { "hobo.reason.code": why.code }));
		return next;
	}

	function rollbackDeltaId(state: RolloutLedgerState, campId: string): DeltaId {
		// SAFETY: a DeltaId is any stable token; this one is derived from the rollout and Camp.
		return `delta-rollback-${digest({ rolloutId: state.rolloutId, campId }).slice(0, 24)}` as DeltaId;
	}

	async function rollbackStep(state: RolloutLedgerState, ctx: CdContext): Promise<[RolloutLedgerState, StepResult]> {
		const rollback = state.rollback;
		if (!rollback) return [state, "waiting"];
		const now = ctx.now();
		if (state.startedAtMs !== undefined) {
			const engine = await d.engine.get(state.rolloutId);
			if (engine && engine.status !== "rolled-back") {
				await d.engine.rollback(state.rolloutId, rollback.reason.code, ctx);
			}
		}
		const exposed = [...state.exposure.entries()].filter(([, percent]) => percent > 0).map(([campId]) => campId);
		// I17: a rollback runs in a closed window only where the window permits it.
		for (const campId of exposed) {
			if (rollback.zero.get(campId)?.observed) continue;
			const topology = await d.topology?.camp(asCamp(campId));
			const window = await d.windows.evaluate({
				campId: asCamp(campId),
				labels: topology?.labels ?? {},
				envType: topology?.envType ?? "",
				windowNames: state.windows,
				atMs: now,
				intent: "rollback",
			});
			if (!window.open && !window.rollbackAllowed) {
				const hold = reason(
					"rollout-rollback-window-closed",
					`freeze ${window.activeFreezes.join(", ") || "(unnamed)"} forbids rollback on Camp ${campId}`,
					campId,
				);
				if (state.hold?.code === hold.code && state.hold.subject === hold.subject) return [state, "waiting"];
				return [await append(state, ROLLOUT_LEDGER.held, bodies.held(hold, now), ctx), "progressed"];
			}
		}
		if (state.hold) return [await append(state, ROLLOUT_LEDGER.released, bodies.released(now), ctx), "progressed"];
		const deadline = progressDeadlineMs(state.plan.verification);
		for (const campId of exposed) {
			const zero = rollback.zero.get(campId);
			const planId = stagePlanId(state.rolloutId, asCamp(campId), 0);
			if (!zero) {
				const requested = await append(
					state,
					ROLLOUT_LEDGER.shiftRequested,
					bodies.shiftRequested({ campId, stageIndex: -1, phase: "rollback", percent: 0, planId, atMs: now }),
					ctx,
				);
				const ack = await shiftTraffic(requested, asCamp(campId), 0, ctx);
				return [
					await append(
						requested,
						ROLLOUT_LEDGER.shifted,
						bodies.shifted({ campId, stageIndex: -1, phase: "rollback", planId, realized: ack.realized, notes: ack.notes, atMs: ctx.now() }),
						ctx,
					),
					"progressed",
				];
			}
			if (zero.observed) continue;
			const status = await d.traffic.status(asCamp(campId), planId);
			if (status?.active === true && status.realized === "full")
				return [
					await append(
						state,
						ROLLOUT_LEDGER.trafficObserved,
						bodies.trafficObserved({ campId, stageIndex: -1, phase: "rollback", planId, atMs: now }),
						ctx,
					),
					"progressed",
				];
			if (now - zero.requestedAtMs > deadline)
				return [
					await finish(
						state,
						"failed",
						[
							rollback.reason,
							reason(
								"rollback-non-convergeable",
								`zero exposure on Camp ${campId} was not observed within ${deadline} ms (${zero.acknowledged?.notes.join("; ") || "no acknowledgement"})`,
								campId,
							),
						],
						ctx,
					),
					"progressed",
				];
			return [state, "waiting"];
		}
		for (const campId of state.plan.targetCampIds) {
			if (rollback.deltas.has(campId) || rollback.settled.has(campId)) continue;
			const current = await d.desired.current(asCamp(campId));
			if (!current || current.freightId !== state.freightId)
				return [
					await append(state, ROLLOUT_LEDGER.rollbackDeltaOpened, bodies.rollbackDeltaOpened(campId, "", "not-applied", now), ctx),
					"progressed",
				];
			const predecessor =
				current.predecessorSetId === ""
					? undefined
					: // SAFETY: a Set record's predecessor id is a SetId by contract.
						await d.desired.get(current.predecessorSetId as SetId);
			if (!predecessor)
				return [
					await append(state, ROLLOUT_LEDGER.rollbackDeltaOpened, bodies.rollbackDeltaOpened(campId, "", "no-predecessor", now), ctx),
					"progressed",
				];
			const deltaId = rollbackDeltaId(state, campId);
			if (!(await d.desired.get(deltaId))) {
				const opened = await d.desired.open(
					create(DeltaRecordSchema, {
						schemaVersion: DELTA_SCHEMA,
						deltaId,
						campId,
						baseSetId: current.setId,
						freightId: predecessor.freightId,
						openedBy: `${ctx.principal.kind}:${ctx.principal.id}`,
						proposal: false,
						openedAt: new Date(now).toISOString(),
						intent: "rollback",
					}),
					ctx,
				);
				if (!opened.ok) {
					if (now - rollback.startedAtMs > deadline)
						return [await finish(state, "failed", [rollback.reason, ...opened.reasons], ctx), "progressed"];
					return [state, "waiting"];
				}
			}
			return [
				await append(state, ROLLOUT_LEDGER.rollbackDeltaOpened, bodies.rollbackDeltaOpened(campId, deltaId, "rollback", now), ctx),
				"progressed",
			];
		}
		const reasons: ReasonRecord[] = [rollback.reason];
		for (const [campId, deltaId] of rollback.deltas)
			reasons.push(reason("rollback-delta-opened", `rollback Delta ${deltaId} to the predecessor Set of Camp ${campId}`, deltaId));
		for (const [campId, why] of rollback.settled)
			if (why === "no-predecessor")
				reasons.push(reason("rollback-no-predecessor", `Camp ${campId} has no predecessor Set`, campId));
		return [await finish(state, "rolled-back", reasons, ctx), "progressed"];
	}

	async function finish(
		state: RolloutLedgerState,
		status: "promoted" | "rolled-back" | "failed",
		reasons: readonly ReasonRecord[],
		ctx: CdContext,
	): Promise<RolloutLedgerState> {
		const next = await append(state, ROLLOUT_LEDGER.finished, bodies.finished(status, reasons, ctx.now()), ctx);
		metric("hobo.cd.rollout.completed", "counter", 1, "{rollout}", attrs(state, { "hobo.rollout.status": status }));
		if (state.startedAtMs !== undefined)
			metric("hobo.cd.rollout.duration", "histogram", ctx.now() - state.startedAtMs, "ms", attrs(state, { "hobo.rollout.status": status }));
		return next;
	}

	async function shiftTraffic(
		state: RolloutLedgerState,
		campId: CampId,
		percent: number,
		ctx: CdContext,
	): Promise<Readonly<{ realized: string; notes: readonly string[] }>> {
		const plan = stageRoutingPlan({ rolloutId: state.rolloutId, campId, tenant: d.tenant, percent, atMs: ctx.now() });
		try {
			const result = await d.traffic.shift({ campId, plan, signal: ctx.signal ?? new AbortController().signal }, ctx);
			metric("hobo.cd.rollout.shifts", "counter", 1, "{shift}", attrs(state, { "hobo.camp.id": campId, "hobo.rollout.percent": percent, "hobo.traffic.realized": result.realized }));
			return { realized: result.realized, notes: result.notes };
		} catch (error) {
			// Ambiguous outcome: never retried blindly, resolved by observation (I5).
			return { realized: "unknown", notes: [`shift threw: ${error instanceof Error ? error.message : String(error)}`] };
		}
	}

	// ── forward progress ──────────────────────────────────────────────────────
	type Boundary = Readonly<{ hold?: ReasonRecord; reject?: ReasonRecord; state: RolloutLedgerState }>;

	async function boundary(
		state: RolloutLedgerState,
		campId: CampId,
		stageIndex: number,
		stage: CampStageState,
		ctx: CdContext,
	): Promise<Boundary> {
		const now = ctx.now();
		const topology = await d.topology?.camp(campId);
		const window = await d.windows.evaluate({
			campId,
			labels: topology?.labels ?? {},
			envType: topology?.envType ?? "",
			windowNames: state.windows,
			atMs: now,
			intent: "promote",
		});
		if (!window.open)
			return {
				state,
				hold: reason(
					WINDOW_CLOSED,
					`window closed for Camp ${campId} at stage ${stageIndex} (${window.activeFreezes.join(", ") || "no allow window open"})${window.nextOpenAtMs === undefined ? "" : `; next open ${new Date(window.nextOpenAtMs).toISOString()}`}`,
					campId,
				),
			};
		const percent = state.plan.stagePercents[stageIndex] ?? 100;
		if (state.plan.strategy === RolloutStrategy.EXPERIMENT && percent === 100 && stageIndex > 0) {
			const verdict = await experiments.conclusion(state.plan.experimentId);
			if (verdict === undefined)
				return {
					state,
					hold: reason("rollout-experiment-running", `experiment ${state.plan.experimentId} has not concluded`, state.plan.experimentId),
				};
			if (verdict !== "ship")
				return {
					state,
					reject: reason("rollout-experiment-rejected", `experiment ${state.plan.experimentId} concluded ${verdict}`, state.plan.experimentId),
				};
		}
		const firstExposure = stageIndex === 0 && state.plan.targetCampIds[0] === campId;
		if (hasObligation(state.obligations, ROLLOUT_OBLIGATIONS.stageApproval) && !firstExposure) {
			const subject = `${state.rolloutId}/${campId}/${stageIndex}`;
			if (!stage.approvalRequestId) {
				const { requestId } = await d.approvals.request(
					{
						subject,
						summary: `Expose ${percent}% of Camp ${campId} to Freight ${state.freightId}`,
						obligations: [ROLLOUT_OBLIGATIONS.stageApproval],
						expiresAtMs: now + CD_DEFAULTS.approvalTtlMs,
					},
					ctx,
				);
				const next = await append(state, ROLLOUT_LEDGER.approvalRequested, bodies.approvalRequested(campId, stageIndex, requestId, now), ctx);
				return { state: next, hold: reason("rollout-approval-pending", `approval ${requestId} for ${subject}`, requestId) };
			}
			const status = await d.approvals.status(stage.approvalRequestId);
			if (status === "pending")
				return { state, hold: reason("rollout-approval-pending", `approval ${stage.approvalRequestId} for ${subject}`, stage.approvalRequestId) };
			if (status !== "approved")
				return { state, reject: reason("rollout-approval-denied", `approval ${stage.approvalRequestId} is ${status}`, stage.approvalRequestId) };
		}
		return { state };
	}

	async function holdAt(state: RolloutLedgerState, hold: ReasonRecord, ctx: CdContext): Promise<[RolloutLedgerState, StepResult]> {
		if (state.hold?.code === hold.code && state.hold.message === hold.message) return [state, "waiting"];
		await d.engine.hold(state.rolloutId, hold, ctx);
		metric("hobo.cd.rollout.held", "counter", 1, "{hold}", attrs(state, { "hobo.reason.code": hold.code }));
		return [await append(state, ROLLOUT_LEDGER.held, bodies.held(hold, ctx.now()), ctx), "progressed"];
	}

	function emptySpec(): VerificationSpecRecord {
		return create(VerificationSpecRecordSchema, {});
	}

	async function forwardStep(state: RolloutLedgerState, ctx: CdContext): Promise<[RolloutLedgerState, StepResult]> {
		const now = ctx.now();
		const engine = await d.engine.get(state.rolloutId);
		if (!engine)
			return [await beginRollback(state, reason("rollout-unknown", "the ramp engine has no record of this rollout", state.rolloutId), ctx), "progressed"];
		if (engine.status === "promoted") return [await finish(state, "promoted", [], ctx), "progressed"];
		if (engine.status === "halted" || engine.status === "failed" || engine.status === "rolled-back")
			return [
				await beginRollback(state, engine.reasons[0] ?? reason("rollout-verification-failed", `ramp engine ${engine.status}`, state.rolloutId), ctx),
				"progressed",
			];
		const strategy = state.plan.strategy;
		const traffic = needsTraffic(strategy);
		const stageIndex = engine.stageIndex;
		const percent = state.plan.stagePercents[stageIndex] ?? 100;
		const pendingCamp = state.plan.targetCampIds.find((camp) => !state.stages.get(stageKey(camp, stageIndex))?.advanced);
		if (pendingCamp === undefined) return [state, "waiting"];
		const campId = asCamp(pendingCamp);
		const stage = state.stages.get(stageKey(campId, stageIndex)) ?? { advanced: false };
		const deadline = progressDeadlineMs(state.plan.verification);
		const spec = state.plan.verification ?? emptySpec();

		// 1. Canary capacity (once per Camp, before its first exposure).
		const capacityRequired = d.capacity !== undefined || hasObligation(state.obligations, ROLLOUT_OBLIGATIONS.hostingBudget);
		if (traffic && capacityRequired && !state.capacity.has(campId)) {
			if (!d.capacity)
				return [await beginRollback(state, reason("canary-capacity-unconfigured", "plan obligations require a hosting-budget reservation", campId), ctx), "progressed"];
			const reserved = await d.capacity.reserve({ rolloutId: state.rolloutId, campId, percent }, ctx);
			if (!reserved.ok)
				return [await beginRollback(state, reserved.reasons[0] ?? reason("canary-capacity-unavailable", "reservation refused", campId), ctx), "progressed"];
			return [await append(state, ROLLOUT_LEDGER.capacityReserved, bodies.capacityReserved(campId, reserved.value.reservationId, now), ctx), "progressed"];
		}

		// 2. Before the Camp's first exposure, the reconciler must report the promoted Set converged.
		if (stageIndex === 0 && !stage.shift && !stage.idleVerificationId && !stage.verificationId) {
			const current = await d.desired.current(campId);
			const observed = await d.desired.status(campId);
			const converged =
				current !== undefined &&
				current.freightId === state.freightId &&
				observed?.status === ReconcileStatus.CONVERGED &&
				observed.setId === current.setId;
			if (!converged) {
				if (now - state.lastProgressAtMs > deadline)
					return [
						await beginRollback(state, reason("rollout-progress-deadline", `Camp ${campId} did not converge on the promoted Set within ${deadline} ms`, campId), ctx),
						"progressed",
					];
				return [state, "waiting"];
			}
		}

		// 3. Blue/green verifies the idle side before any traffic moves.
		if (strategy === RolloutStrategy.BLUE_GREEN && stageIndex === 0 && !stage.shift) {
			if (!stage.idleVerificationId) {
				const id = await d.verification.start({ spec, freightId: state.freightId, campId, cohortAware: false }, ctx);
				return [
					await append(state, ROLLOUT_LEDGER.verificationStarted, bodies.verificationStarted({ campId, stageIndex, phase: "idle", verificationId: id, atMs: now }), ctx),
					"progressed",
				];
			}
			if (stage.idleVerdict === undefined || stage.idleVerdict === VerificationVerdict.UNSPECIFIED) {
				const result = await d.verification.get(asVerification(stage.idleVerificationId));
				if (!result || result.verdict === VerificationVerdict.UNSPECIFIED) return [state, "waiting"];
				return [
					await append(
						state,
						ROLLOUT_LEDGER.stageVerified,
						bodies.stageVerified({ campId, stageIndex, phase: "idle", verificationId: stage.idleVerificationId, verdict: result.verdict, atMs: now }),
						ctx,
					),
					"progressed",
				];
			}
			if (stage.idleVerdict !== VerificationVerdict.PASS)
				return [
					await beginRollback(state, reason("rollout-verification-failed", `idle-side verification ${stage.idleVerificationId} on Camp ${campId} did not pass`, stage.idleVerificationId), ctx),
					"progressed",
				];
		}

		// 4. Stage boundary: windows, experiment, approval — hold, never abort mid-stage (I17).
		if (traffic && !stage.shift) {
			const gate = await boundary(state, campId, stageIndex, stage, ctx);
			if (gate.reject) return [await beginRollback(gate.state, gate.reject, ctx), "progressed"];
			if (gate.hold) return holdAt(gate.state, gate.hold, ctx);
			if (gate.state.hold) return [await append(gate.state, ROLLOUT_LEDGER.released, bodies.released(now), ctx), "progressed"];
			const planId = stagePlanId(state.rolloutId, campId, percent);
			const requested = await append(
				gate.state,
				ROLLOUT_LEDGER.shiftRequested,
				bodies.shiftRequested({ campId, stageIndex, phase: "stage", percent, planId, atMs: now }),
				ctx,
			);
			const ack = await shiftTraffic(requested, campId, percent, ctx);
			return [
				await append(
					requested,
					ROLLOUT_LEDGER.shifted,
					bodies.shifted({ campId, stageIndex, phase: "stage", planId, realized: ack.realized, notes: ack.notes, atMs: ctx.now() }),
					ctx,
				),
				"progressed",
			];
		}

		// 5. Observed traffic is authoritative over the provider's acknowledgement.
		if (traffic && stage.shift && !stage.shift.observed) {
			if (stage.shift.acknowledged?.realized === "none")
				return [
					await beginRollback(state, reason("rollout-shift-failed", `Station cutover did not realize ${percent}% on Camp ${campId}: ${stage.shift.acknowledged.notes.join("; ")}`, campId), ctx),
					"progressed",
				];
			const status = await d.traffic.status(campId, stagePlanId(state.rolloutId, campId, percent));
			if (status?.active === true && status.realized === "full")
				return [
					await append(state, ROLLOUT_LEDGER.trafficObserved, bodies.trafficObserved({ campId, stageIndex, phase: "stage", planId: stage.shift.planId, atMs: now }), ctx),
					"progressed",
				];
			if (now - stage.shift.requestedAtMs > deadline)
				return [
					await beginRollback(
						state,
						reason("rollout-traffic-unconverged", `provider acknowledged ${stage.shift.acknowledged?.realized ?? "nothing"} but traffic on Camp ${campId} is not the ${percent}% split after ${deadline} ms`, campId),
						ctx,
					),
					"progressed",
				];
			return [state, "waiting"];
		}

		// 6. Verification at this stage.
		if (!stage.verificationId) {
			const id = await d.verification.start({ spec, freightId: state.freightId, campId, cohortAware: cohortAware(strategy, percent) }, ctx);
			return [
				await append(state, ROLLOUT_LEDGER.verificationStarted, bodies.verificationStarted({ campId, stageIndex, phase: "stage", verificationId: id, atMs: now }), ctx),
				"progressed",
			];
		}
		const result = await d.verification.get(asVerification(stage.verificationId));
		if (stage.verdict === undefined || stage.verdict === VerificationVerdict.UNSPECIFIED) {
			if (!result || result.verdict === VerificationVerdict.UNSPECIFIED) return [state, "waiting"];
			return [
				await append(
					state,
					ROLLOUT_LEDGER.stageVerified,
					bodies.stageVerified({ campId, stageIndex, phase: "stage", verificationId: stage.verificationId, verdict: result.verdict, atMs: now }),
					ctx,
				),
				"progressed",
			];
		}
		const outcome: VerificationResultRecord =
			result ?? create(VerificationResultRecordSchema, { verificationId: stage.verificationId, campId, freightId: state.freightId, verdict: stage.verdict });
		// 7. Advance the ramp engine with the outcome; a non-PASS halts it and rolls back.
		await d.engine.advance(state.rolloutId, outcome, ctx);
		if (stage.verdict !== VerificationVerdict.PASS)
			return [
				await beginRollback(
					state,
					reason("rollout-verification-failed", `verification ${stage.verificationId} on Camp ${campId} at ${percent}% was ${VerificationVerdict[stage.verdict]}`, stage.verificationId),
					ctx,
				),
				"progressed",
			];
		metric("hobo.cd.rollout.stages", "counter", 1, "{stage}", attrs(state, { "hobo.camp.id": campId, "hobo.rollout.percent": percent }));
		return [await append(state, ROLLOUT_LEDGER.advanced, bodies.advanced(campId, stageIndex, now), ctx), "progressed"];
	}

	async function drive(rolloutId: RolloutId, ctx: CdContext): Promise<RolloutSnapshot> {
		return exclusive(rolloutId, async () => {
			let state = await load(rolloutId);
			if (!state) return unknownSnapshot(rolloutId, "rollout-unknown", "no rollout ledger");
			for (let steps = 0; steps < MAX_STEPS_PER_DRIVE; steps += 1) {
				if (state.finished || state.refused || state.startedAtMs === undefined) break;
				let result: StepResult;
				try {
					[state, result] = state.rollback ? await rollbackStep(state, ctx) : await forwardStep(state, ctx);
				} catch (error) {
					// A CAS conflict means another driver progressed this rollout; re-read and stop.
					const reloaded = await load(rolloutId);
					if (reloaded && reloaded.seq !== state.seq) {
						state = reloaded;
						break;
					}
					throw error;
				}
				if (result === "waiting") break;
			}
			return snapshotOf(state);
		});
	}

	return {
		async plan(input, ctx): Promise<Outcome<RolloutPlanRecord>> {
			const promotion = input.promotion;
			if (promotion.promotionId === "") return refuse("rollout-promotion-missing", "promotion_id is empty");
			if (promotion.freightId === "") return refuse("rollout-freight-missing", "freight_id is empty", promotion.promotionId);
			if (promotion.targetCampIds.length === 0)
				return refuse("rollout-targets-missing", "target_camp_ids is empty", promotion.promotionId);
			const strategy = effectiveStrategy(promotion.strategy);
			const stages = stagePercentsFor(strategy, input.stagePercents);
			if (!stages.ok) return stages;
			const targets = promotion.targetCampIds.map(asCamp);
			const offerings = await Promise.all(targets.map((camp) => d.traffic.offerings(camp)));
			const rolloutId = rolloutIdFor({
				tenant: d.tenant,
				promotion,
				strategy,
				stagePercents: stages.value,
				verification: input.verification,
				windows: input.windows,
				obligations: input.obligations,
				offerings,
			});
			return exclusive(rolloutId, async (): Promise<Outcome<RolloutPlanRecord>> => {
				const existing = await load(rolloutId);
				const refusalsOf = (plan: RolloutPlanRecord) => plan.lowerings.flatMap((l) => (l.refusal ? [l.refusal] : []));
				if (existing)
					return existing.refused ? { ok: false, reasons: refusalsOf(existing.plan) } : { ok: true, value: existing.plan };
				const fallbackForbidden = hasObligation(input.obligations, ROLLOUT_OBLIGATIONS.noFallback);
				const lowerings = targets.map((campId, index) =>
					lowerCamp({ campId, strategy, offerings: offerings[index] ?? [], fallbackForbidden }),
				);
				const experimentId =
					strategy === RolloutStrategy.EXPERIMENT
						? (input.obligations.find((o) => o.kind === ROLLOUT_OBLIGATIONS.experiment)?.id ?? promotion.promotionId)
						: "";
				const plan = create(RolloutPlanRecordSchema, {
					rolloutId,
					promotionId: promotion.promotionId,
					strategy,
					stagePercents: [...stages.value],
					targetCampIds: [...targets],
					lowerings,
					verification: input.verification,
					experimentId,
				});
				const refusals = refusalsOf(plan);
				await d.store.append(
					ROLLOUT_LEDGER.stream(rolloutId),
					[
						{
							type: CD_EVENTS.RolloutLowered,
							data: loweredBody({
								plan,
								// SAFETY: the promotion's Freight id (FreightId by contract).
								freightId: promotion.freightId as FreightId,
								windows: input.windows,
								obligations: input.obligations,
								atMs: ctx.now(),
								refused: refusals.length > 0,
							}),
						},
					],
					{ expectedSeq: 0, actor: ctx.principal, tenant: d.tenant },
				);
				for (const lowering of lowerings)
					metric("hobo.cd.rollout.lowered", "counter", 1, "{camp}", {
						"hobo.rollout.id": rolloutId,
						"hobo.camp.id": lowering.campId,
						"hobo.rollout.strategy": RolloutStrategy[strategy] ?? "UNSPECIFIED",
						"hobo.traffic.offering": lowering.offeringId || "none",
						"hobo.traffic.fallback": lowering.fallbackFrom.length > 0,
						"hobo.reason.code": lowering.refusal?.code ?? "",
					});
				return refusals.length > 0 ? { ok: false, reasons: refusals } : { ok: true, value: plan };
			});
		},

		async run(plan, ctx) {
			// SAFETY: the plan record's rollout id (RolloutId by contract).
			const rolloutId = plan.rolloutId as RolloutId;
			const started = await exclusive(rolloutId, async (): Promise<RolloutSnapshot | undefined> => {
				const state = await load(rolloutId);
				if (!state) return unknownSnapshot(rolloutId, "rollout-unplanned", "run() before plan()");
				if (state.refused) return snapshotOf(state);
				if (
					canonicalJson(toJson(RolloutPlanRecordSchema, plan)) !==
					canonicalJson(toJson(RolloutPlanRecordSchema, state.plan))
				)
					return unknownSnapshot(rolloutId, "rollout-plan-mismatch", "the plan differs from the recorded plan");
				if (state.startedAtMs === undefined) {
					await d.engine.start(state.plan, ctx);
					await append(state, ROLLOUT_LEDGER.started, bodies.started(ctx.now()), ctx);
				}
				return undefined;
			});
			return started ?? drive(rolloutId, ctx);
		},

		async rollback(input, ctx) {
			const state = await exclusive(input.rolloutId, async () => {
				const current = await load(input.rolloutId);
				if (!current) return undefined;
				return beginRollback(current, reason("rollback-requested", input.reason, input.rolloutId), ctx);
			});
			if (!state) return unknownSnapshot(input.rolloutId, "rollout-unknown", "no rollout ledger");
			return drive(input.rolloutId, ctx);
		},

		async get(rolloutId) {
			const state = await load(rolloutId);
			return state ? snapshotOf(state) : undefined;
		},

		async tick(ctx) {
			const ids = new Set<RolloutId>();
			for await (const entry of d.store.readAll({ tenant: d.tenant, filter: { type: ROLLOUT_LEDGER.started } })) {
				const prefix = ROLLOUT_LEDGER.stream("");
				if (entry.event.streamId.startsWith(prefix))
					// SAFETY: the stream id is `cd-rollout-<rolloutId>` by construction.
					ids.add(entry.event.streamId.slice(prefix.length) as RolloutId);
			}
			for (const rolloutId of [...ids].sort()) {
				try {
					await drive(rolloutId, ctx);
				} catch {
					metric("hobo.cd.rollout.tick_errors", "counter", 1, "{error}", { "hobo.rollout.id": rolloutId });
				}
			}
		},
	};
}
