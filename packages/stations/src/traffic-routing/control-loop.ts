// One service actor owns routing. Persist the in-flight intent before external
// effects; replay consumes snapshots/facts and does not repeat provider writes.
import { create } from "@bufbuild/protobuf";
import type {
	ApplyResult,
	MinAvailabilitySpec,
	PolicyDecision,
	ResiliencySpec,
	RoutingPlan,
	TrafficRoutingPort,
} from "@hobo/core";
import { parseRoutingPlan, parseRoutingPlanId } from "@hobo/core";
import {
	type CreditLedgerView,
	createDispatcherRegistry,
	type DispatchFact,
	decideDispatch,
} from "@hobo/dispatcher";
import {
	type RoutingControlStateRecord,
	RoutingControlStateRecordSchema,
} from "../_generated/routing_control_pb.js";
import { isJsonObject, parseJsonValue } from "../json.js";
import {
	type CutoverHealthGate,
	type CutoverPrecondition,
	executeRoutingCutover,
	routingHealthObservationReady,
} from "./cutover.js";
import {
	applyRoutingObservations,
	type RoutingObservations,
} from "./observations.js";
import {
	type RoutingSynthesisDenial,
	type RoutingTopology,
	synthesizeRoutingPlan,
} from "./synthesize.js";

export const ROUTING_LOOP_EVENTS = Object.freeze({
	ReplanProposed: "routing.ReplanProposed",
	Reapplied: "routing.Reapplied",
	ReplanHeld: "routing.ReplanHeld",
	ReplanDenied: "routing.ReplanDenied",
	ReconciliationRequired: "routing.ReconciliationRequired",
} as const);
export interface RoutingStabilityPolicy {
	cooldownSeconds: number;
	hysteresisMinSavingsUsd?: number;
	maxSwapsPerWindow?: number;
	windowSeconds?: number;
}
export interface BackendCostModel {
	backendId: string;
	listUnitCost: number;
	switchingCost?: number;
}
export type RoutingControlSignal =
	| Readonly<{ kind: "budget"; fact: { type: string; data?: unknown } }>
	| Readonly<{ kind: "health"; observations: RoutingObservations }>;
type Reason = RoutingSynthesisDenial | { code: string; message: string };
export type RoutingControlOutcome =
	| Readonly<{
			action: "reapplied";
			plan: RoutingPlan;
			applyResult: ApplyResult;
			selectedBackendId: string;
			facts: readonly DispatchFact[];
	  }>
	| Readonly<{
			action: "held";
			reason: "cooldown" | "flip-limit";
			selectedBackendId: string;
			facts: readonly DispatchFact[];
	  }>
	| Readonly<{
			action: "noop";
			reason: "incumbent-optimal";
			facts: readonly DispatchFact[];
	  }>
	| Readonly<{
			action: "rolled-back";
			reasons: readonly Reason[];
			selectedBackendId: string;
			facts: readonly DispatchFact[];
	  }>
	| Readonly<{
			action: "reconciliation-required";
			reasons: readonly Reason[];
			pendingPlanId: string;
			facts: readonly DispatchFact[];
	  }>
	| Readonly<{
			action: "denied";
			reasons: readonly Reason[];
			facts: readonly DispatchFact[];
	  }>;
export interface RoutingControlLoopOptions {
	topology: RoutingTopology;
	availability?: MinAvailabilitySpec;
	resiliency?: ResiliencySpec;
	policyDecision: PolicyDecision;
	costModel: readonly BackendCostModel[];
	healthGate?: CutoverHealthGate;
	ledgerView?: () => CreditLedgerView;
	recoveryLedgerView?: () => CreditLedgerView;
	beforeApply?: (
		plan: RoutingPlan,
		phase: "ramp" | "restore",
		percent: number,
		reason: "optimization" | "recovery" | "restore",
	) => Promise<void>;
	port: TrafficRoutingPort;
	stability: RoutingStabilityPolicy;
	incumbentBackendId: string;
	cutover?: {
		rampSteps?: readonly number[];
		healthGate?: CutoverHealthGate;
		restorationHealthGate?: CutoverHealthGate;
		consecutiveFailuresToRollback?: number;
		precondition?: CutoverPrecondition;
		minObservationSeconds?: number;
		maxObservationAgeSeconds?: number;
	};
	units?: number;
	clock?: () => string;
	onFact?: (fact: DispatchFact) => void;
	/** A durable host restores this generated record and CAS-persists each change
	 * under its service actor fence. Absent means a process-local adapter only. */
	initialState?: RoutingControlStateRecord;
	persistState?: (
		state: RoutingControlStateRecord,
		expectedStateVersion: number,
	) => Promise<void>;
}
export interface RoutingControlLoop {
	handleSignal(signal: RoutingControlSignal): Promise<RoutingControlOutcome>;
	incumbent(): string;
	revision(): number;
	snapshot(): RoutingControlStateRecord;
	/** Observe an interrupted final apply/restore; intermediate ramps remain
	 * pending for the supervising transition saga to resume or restore. */
	reconcilePending(): Promise<RoutingControlOutcome>;
}
export function createRoutingControlLoop(
	options: RoutingControlLoopOptions,
): RoutingControlLoop {
	const clock = options.clock ?? (() => new Date().toISOString());
	const stability = options.stability;
	const constraints: Pick<
		RoutingControlLoopOptions,
		"availability" | "resiliency"
	> = {};
	if (options.availability) constraints.availability = options.availability;
	if (options.resiliency) constraints.resiliency = options.resiliency;
	let state = options.initialState
		? structuredClone(options.initialState)
		: create(RoutingControlStateRecordSchema, {
				service: options.topology.service,
				tenantId: options.topology.tenantId,
				stationId: options.topology.stationId ?? "",
				incumbentBackendId: options.incumbentBackendId,
			});
	if (
		state.service !== options.topology.service ||
		state.tenantId !== options.topology.tenantId ||
		state.stationId !== (options.topology.stationId ?? "")
	)
		throw new Error("routing snapshot scope mismatch");
	if (!options.topology.backends.some((b) => b.id === state.incumbentBackendId))
		throw new Error("routing snapshot incumbent is not in topology");
	if (
		!Number.isFinite(stability.cooldownSeconds) ||
		stability.cooldownSeconds < 0
	)
		throw new Error("routing cooldown must be non-negative");
	if (
		!Number.isSafeInteger(state.revision) ||
		state.revision < 0 ||
		state.revision > 4294967295 ||
		!Number.isSafeInteger(state.stateVersion) ||
		state.stateVersion < 0 ||
		state.stateVersion > 4294967295 ||
		state.swapTimesMs.some((time) => !Number.isFinite(time) || time < 0) ||
		(state.lastSwapAtMs !== undefined &&
			(!Number.isFinite(state.lastSwapAtMs) || state.lastSwapAtMs < 0))
	)
		throw new Error("invalid routing snapshot counters");
	if (
		state.pendingPlanId &&
		(!options.topology.backends.some(
			(backend) => backend.id === state.pendingBackendId,
		) ||
			!["ramp", "restore"].includes(state.pendingPhase) ||
			!Number.isInteger(state.pendingPercent) ||
			state.pendingPercent < 0 ||
			state.pendingPercent > 100)
	)
		throw new Error("invalid pending routing snapshot");
	if (
		state.challengerBackendId &&
		(!options.topology.backends.some(
			(backend) => backend.id === state.challengerBackendId,
		) ||
			!Number.isFinite(Date.parse(state.savingsSince)))
	)
		throw new Error("invalid routing dwell evidence");
	if (
		(stability.hysteresisMinSavingsUsd !== undefined &&
			(!Number.isFinite(stability.hysteresisMinSavingsUsd) ||
				stability.hysteresisMinSavingsUsd < 0)) ||
		(stability.maxSwapsPerWindow !== undefined &&
			(!Number.isSafeInteger(stability.maxSwapsPerWindow) ||
				stability.maxSwapsPerWindow < 1 ||
				stability.windowSeconds === undefined)) ||
		(stability.windowSeconds !== undefined &&
			(!Number.isFinite(stability.windowSeconds) ||
				stability.windowSeconds <= 0))
	)
		throw new Error("invalid routing stability policy");
	let observations: RoutingObservations | undefined;
	// A restored intent timestamp does not prove when an uncertain write took
	// effect. Establish one fresh, persisted baseline per observed pending plan.
	let observedPendingPlanId = "";
	let queue: Promise<void> = Promise.resolve();
	const serialized = <T>(op: () => Promise<T>): Promise<T> => {
		const task = queue.then(op);
		queue = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	};
	const checkpoint = async (patch: Partial<RoutingControlStateRecord>) => {
		const previous = state.stateVersion;
		if (previous >= 4294967295)
			throw new Error("routing snapshot version exhausted");
		const next = create(RoutingControlStateRecordSchema, {
			...state,
			...patch,
			stateVersion: previous + 1,
		});
		await options.persistState?.(structuredClone(next), previous);
		state = next;
	};
	const emit = (facts: DispatchFact[], fact: DispatchFact) => {
		facts.push(fact);
		options.onFact?.(fact);
	};
	const reconciliation = (
		facts: DispatchFact[],
		message: string,
	): RoutingControlOutcome => {
		const reasons = [{ code: "routing-outcome-unknown", message }];
		emit(facts, {
			type: ROUTING_LOOP_EVENTS.ReconciliationRequired,
			data: {
				service: state.service,
				pendingPlanId: state.pendingPlanId,
				reasons,
			},
		});
		return Object.freeze({
			action: "reconciliation-required",
			reasons,
			pendingPlanId: state.pendingPlanId,
			facts,
		});
	};
	const clearPending = () => ({
		pendingPlanId: "",
		pendingBackendId: "",
		pendingPercent: 0,
		pendingPhase: "",
		pendingStartedAtMs: 0,
		pendingPlanJson: "",
	});
	async function handle(
		signal: RoutingControlSignal,
	): Promise<RoutingControlOutcome> {
		const facts: DispatchFact[] = [];
		if (state.pendingPlanId)
			return reconciliation(
				facts,
				"an earlier provider effect must be reconciled before new routing",
			);
		if (
			signal.kind === "budget" &&
			((signal.fact.type !== "budget.ThresholdCrossed" &&
				signal.fact.type !== "budget.Recovered") ||
				!isJsonObject(signal.fact.data) ||
				signal.fact.data.tenantId !== state.tenantId)
		)
			return {
				action: "denied",
				reasons: [
					{
						code: "budget-signal-scope-mismatch",
						message: "budget signal does not belong to this routing tenant",
					},
				],
				facts,
			};
		const now = clock();
		const nowMs = Date.parse(now);
		if (!Number.isFinite(nowMs))
			throw new Error("routing clock must be a valid instant");
		if (signal.kind === "health") observations = signal.observations;
		const topology = applyRoutingObservations(options.topology, observations);
		const healthy = topology.backends.filter((b) => b.healthy !== false);
		const modelled = new Map(
			options.costModel.map((m) => [m.backendId, m] as const),
		);
		const candidates = healthy
			.filter((b) => modelled.has(b.id))
			.map((b) => ({
				id: b.id,
				providerId: b.id,
				category: "traffic-backend" as const,
				listUnitCost: modelled.get(b.id)?.listUnitCost ?? 0,
				switchingCost: modelled.get(b.id)?.switchingCost ?? 0,
			}));
		const mandatoryRecovery = !healthy.some(
			(b) => b.id === state.incumbentBackendId,
		);
		const ledgerView = (mandatoryRecovery
			? options.recoveryLedgerView?.()
			: undefined) ??
			options.ledgerView?.() ?? {
				view: "CreditLedgerView" as const,
				seq: 0,
				accounts: [],
			};
		let decision: ReturnType<typeof decideDispatch>;
		try {
			const request: Parameters<typeof decideDispatch>[0] = {
				registry: createDispatcherRegistry(candidates),
				category: "traffic-backend",
				dispatchId: `route:${topology.service}:r${state.revision + 1}`,
				units: options.units ?? 1,
				ledgerView,
				incumbentProviderId: state.incumbentBackendId,
			};
			if (
				!mandatoryRecovery &&
				stability.hysteresisMinSavingsUsd !== undefined
			) {
				request.hysteresis = {
					incumbentProviderId: state.incumbentBackendId,
					minimumSavings: stability.hysteresisMinSavingsUsd,
					dwellWindow: `PT${stability.cooldownSeconds}S`,
					observedAt: now,
				};
				if (state.challengerBackendId) {
					request.hysteresis.challengerProviderId = state.challengerBackendId;
					request.hysteresis.savingsSince = state.savingsSince;
				}
			}
			decision = decideDispatch(request);
		} catch (error) {
			const reasons = [
				{
					code: "dispatch-input-invalid",
					message:
						error instanceof Error
							? error.message
							: "invalid routing decision input",
				},
			];
			return { action: "denied", reasons, facts };
		}
		if (!decision.ok) {
			const reasons = [
				{
					code: "dispatch-failed",
					message:
						decision.reason ?? "no affordable eligible routing candidate",
				},
			];
			emit(facts, {
				type: ROUTING_LOOP_EVENTS.ReplanDenied,
				data: { service: state.service, reasons },
			});
			return { action: "denied", reasons, facts };
		}
		emit(facts, decision.dispatchEvent);
		const rawWinner =
			decision.hysteresis.rawWinner ?? decision.selectedProvider;
		const savings = decision.hysteresis.savings;
		const sustained =
			rawWinner !== state.incumbentBackendId &&
			(savings === undefined ||
				savings >= (stability.hysteresisMinSavingsUsd ?? 0));
		await checkpoint(
			sustained
				? {
						challengerBackendId: rawWinner,
						savingsSince:
							state.challengerBackendId === rawWinner
								? state.savingsSince
								: now,
					}
				: { challengerBackendId: "", savingsSince: "" },
		);
		const selectedBackendId = decision.selectedProvider;
		if (selectedBackendId === state.incumbentBackendId)
			return { action: "noop", reason: "incumbent-optimal", facts };
		if (!options.persistState || !options.ledgerView || !options.beforeApply)
			return {
				action: "denied",
				reasons: [
					{
						code: "financial-supervisor-required",
						message:
							"routing changes require durable persistence, a ledger snapshot and financial admission before effects",
					},
				],
				facts,
			};
		if (!options.cutover && !options.healthGate)
			return {
				action: "denied",
				reasons: [
					{
						code: "health-supervisor-required",
						message:
							"non-progressive changes require an explicit health observation gate",
					},
				],
				facts,
			};
		const topologyEligibility = topology.costRouting;
		if (
			topologyEligibility !== "stateless" &&
			topologyEligibility !== "active-active-eventual" &&
			topologyEligibility !== "pinned-with-replica"
		) {
			const reasons = [
				{
					code: "cost-routing-ineligible",
					message:
						"cost routing requires explicit stateless or replica-safe topology evidence",
				},
			];
			emit(facts, {
				type: ROUTING_LOOP_EVENTS.ReplanDenied,
				data: { service: state.service, reasons },
			});
			return { action: "denied", reasons, facts };
		}
		const incumbentEligible = decision.ranking.some(
			(c: { providerId: string; eligible?: boolean }) =>
				c.providerId === state.incumbentBackendId && c.eligible === true,
		);
		const forced = mandatoryRecovery || !incumbentEligible;
		const synthesis = synthesizeRoutingPlan({
			topology: {
				...topology,
				backends: topology.backends.map((b) => ({
					...b,
					weight: b.id === selectedBackendId ? 100 : 1,
				})),
			},
			...constraints,
			policyDecision: options.policyDecision,
			now,
			planId: `plan:${topology.service}:${topology.stationId}:r${state.revision + 1}`,
			weightStrategy: "static",
		});
		if (synthesis.kind === "denied") {
			emit(facts, {
				type: ROUTING_LOOP_EVENTS.ReplanDenied,
				data: { service: state.service, reasons: synthesis.reasons },
			});
			return { action: "denied", reasons: synthesis.reasons, facts };
		}
		if (
			!forced &&
			state.lastSwapAtMs !== undefined &&
			nowMs - state.lastSwapAtMs < stability.cooldownSeconds * 1000
		) {
			emit(facts, {
				type: ROUTING_LOOP_EVENTS.ReplanHeld,
				data: { service: state.service, reason: "cooldown", selectedBackendId },
			});
			return { action: "held", reason: "cooldown", selectedBackendId, facts };
		}
		const swaps =
			stability.windowSeconds === undefined
				? []
				: state.swapTimesMs.filter(
						(t) => nowMs - t < (stability.windowSeconds ?? 0) * 1000,
					);
		if (
			!forced &&
			stability.maxSwapsPerWindow !== undefined &&
			stability.windowSeconds !== undefined &&
			swaps.length >= stability.maxSwapsPerWindow
		) {
			emit(facts, {
				type: ROUTING_LOOP_EVENTS.ReplanHeld,
				data: {
					service: state.service,
					reason: "flip-limit",
					selectedBackendId,
				},
			});
			return { action: "held", reason: "flip-limit", selectedBackendId, facts };
		}
		await checkpoint({
			revision: state.revision + 1,
			pendingPlanId: synthesis.plan.planId,
			pendingBackendId: selectedBackendId,
			pendingPercent: 100,
			pendingPhase: "ramp",
			pendingStartedAtMs: nowMs,
			pendingPlanJson: JSON.stringify(synthesis.plan),
			swapTimesMs: swaps,
		});
		emit(facts, {
			type: ROUTING_LOOP_EVENTS.ReplanProposed,
			data: {
				service: state.service,
				planId: synthesis.plan.planId,
				fromBackendId: state.incumbentBackendId,
				toBackendId: selectedBackendId,
				revision: state.revision,
			},
		});
		if (options.cutover) {
			const result = await executeRoutingCutover({
				topology,
				policyDecision: options.policyDecision,
				port: options.port,
				fromBackendId: state.incumbentBackendId,
				toBackendId: selectedBackendId,
				...options.cutover,
				...constraints,
				clock,
				planIdPrefix: `plan:${topology.service}:${topology.stationId}:r${state.revision}`,
				onFact: (fact) => emit(facts, fact),
				beforeApply: async (plan, phase, percent) => {
					await checkpoint({
						pendingPlanId: plan.planId,
						pendingBackendId:
							phase === "restore"
								? state.incumbentBackendId
								: selectedBackendId,
						pendingPercent: percent,
						pendingPhase: phase,
						pendingStartedAtMs: Date.parse(clock()),
						pendingPlanJson: JSON.stringify(plan),
					});
					await options.beforeApply?.(
						plan,
						phase,
						percent,
						phase === "restore"
							? "restore"
							: forced
								? "recovery"
								: "optimization",
					);
				},
			});
			if (result.refused) {
				await checkpoint(clearPending());
				return { action: "denied", reasons: result.reasons, facts };
			}
			if (result.recoveryPending)
				return reconciliation(
					facts,
					"cutover or restoration requires provider reconciliation",
				);
			if (result.rolledBack) {
				await checkpoint({ ...clearPending(), lastSwapAtMs: nowMs });
				return {
					action: "rolled-back",
					reasons: result.reasons,
					selectedBackendId,
					facts,
				};
			}
			const finalPlan = result.plans.at(-1);
			const applyResult = result.finalApplyResult;
			if (!result.ok || !finalPlan || !applyResult)
				return reconciliation(
					facts,
					"cutover did not establish a final realized plan",
				);
			await checkpoint({
				...clearPending(),
				incumbentBackendId: selectedBackendId,
				lastSwapAtMs: nowMs,
				swapTimesMs: [...state.swapTimesMs, nowMs],
				challengerBackendId: "",
				savingsSince: "",
			});
			emit(facts, {
				type: ROUTING_LOOP_EVENTS.Reapplied,
				data: {
					service: state.service,
					planId: finalPlan.planId,
					toBackendId: selectedBackendId,
					revision: state.revision,
				},
			});
			return {
				action: "reapplied",
				plan: finalPlan,
				applyResult,
				selectedBackendId,
				facts,
			};
		}
		let applyResult: ApplyResult;
		try {
			await options.beforeApply?.(
				synthesis.plan,
				"ramp",
				100,
				forced ? "recovery" : "optimization",
			);
			applyResult = await options.port.apply(synthesis.plan);
			const status = await options.port.status(synthesis.plan.planId);
			if (
				applyResult.planId !== synthesis.plan.planId ||
				applyResult.provider !== options.port.provider ||
				applyResult.realized !== "full" ||
				status?.planId !== synthesis.plan.planId ||
				!status?.active ||
				status.realized !== "full"
			)
				return reconciliation(
					facts,
					"routing write was not observed active and fully realized",
				);
			const gate = options.healthGate;
			if (!gate)
				return reconciliation(
					facts,
					"destination health observation is missing",
				);
			const health = await gate({
				percent: 100,
				phase: "ramp",
				backendId: selectedBackendId,
				plan: synthesis.plan,
				applyResult,
			});
			if (
				!routingHealthObservationReady(health, {
					backendId: selectedBackendId,
					planId: synthesis.plan.planId,
					appliedAtMs: state.pendingStartedAtMs,
					nowMs: Date.parse(clock()),
					minimumSeconds: 0,
				})
			)
				return reconciliation(facts, "destination health is not confirmed");
		} catch {
			return reconciliation(
				facts,
				"routing write or observation failed; outcome is unknown",
			);
		}
		await checkpoint({
			...clearPending(),
			incumbentBackendId: selectedBackendId,
			lastSwapAtMs: nowMs,
			swapTimesMs: [...state.swapTimesMs, nowMs],
			challengerBackendId: "",
			savingsSince: "",
		});
		emit(facts, {
			type: ROUTING_LOOP_EVENTS.Reapplied,
			data: {
				service: state.service,
				planId: synthesis.plan.planId,
				toBackendId: selectedBackendId,
				realized: applyResult.realized,
				revision: state.revision,
			},
		});
		return {
			action: "reapplied",
			plan: synthesis.plan,
			applyResult,
			selectedBackendId,
			facts,
		};
	}
	async function reconcilePending(): Promise<RoutingControlOutcome> {
		const facts: DispatchFact[] = [];
		if (!state.pendingPlanId)
			return { action: "noop", reason: "incumbent-optimal", facts };
		let status: Awaited<ReturnType<TrafficRoutingPort["status"]>>;
		try {
			status = await options.port.status(
				parseRoutingPlanId(state.pendingPlanId),
			);
		} catch {
			return reconciliation(facts, "provider state remains unavailable");
		}
		if (
			status?.planId !== state.pendingPlanId ||
			!status?.active ||
			status.realized !== "full" ||
			(state.pendingPhase === "ramp" && state.pendingPercent !== 100)
		)
			return reconciliation(
				facts,
				"interrupted routing needs the supervising saga to resume or restore",
			);
		let approvedPlan: RoutingPlan;
		try {
			approvedPlan = parseRoutingPlan(parseJsonValue(state.pendingPlanJson));
		} catch {
			return reconciliation(
				facts,
				"pending approved plan artifact is unavailable",
			);
		}
		if (
			approvedPlan.planId !== state.pendingPlanId ||
			approvedPlan.intent.service !== state.service ||
			approvedPlan.intent.tenantId !== state.tenantId ||
			approvedPlan.stationId !== state.stationId ||
			approvedPlan.railHash !== options.topology.railHash
		)
			return reconciliation(facts, "pending routing artifact scope changed");
		const currentTopology = {
			...options.topology,
			backends: approvedPlan.backends.map((backend) => {
				const healthy = options.topology.backends.find(
					(candidate) => candidate.id === backend.id,
				)?.healthy;
				if (healthy === undefined) return { ...backend };
				return { ...backend, healthy };
			}),
		};
		for (const availability of [
			approvedPlan.intent.availability,
			options.availability,
		]) {
			const currentConstraints: Pick<
				RoutingControlLoopOptions,
				"availability" | "resiliency"
			> = {};
			if (availability) currentConstraints.availability = availability;
			if (approvedPlan.intent.resiliency)
				currentConstraints.resiliency = approvedPlan.intent.resiliency;
			const checked = synthesizeRoutingPlan({
				topology: currentTopology,
				policyDecision: options.policyDecision,
				...currentConstraints,
				planId: state.pendingPlanId,
				now: clock(),
				weightStrategy: "static",
			});
			if (checked.kind === "denied")
				return reconciliation(
					facts,
					"pending routing no longer satisfies policy or availability",
				);
		}
		const gate =
			state.pendingPhase === "restore"
				? options.cutover?.restorationHealthGate
				: (options.cutover?.healthGate ?? options.healthGate);
		if (!gate)
			return reconciliation(
				facts,
				"pending routing requires a scoped health observation",
			);
		if (observedPendingPlanId !== state.pendingPlanId) {
			const observedAtMs = Date.parse(clock());
			if (!Number.isFinite(observedAtMs))
				return reconciliation(facts, "routing observation clock is invalid");
			await checkpoint({ pendingStartedAtMs: observedAtMs });
			observedPendingPlanId = state.pendingPlanId;
		}
		let health: Awaited<ReturnType<CutoverHealthGate>>;
		try {
			health = await gate({
				percent: state.pendingPercent,
				phase: state.pendingPhase === "restore" ? "restore" : "ramp",
				backendId: state.pendingBackendId,
				plan: approvedPlan,
				applyResult: {
					planId: approvedPlan.planId,
					provider: options.port.provider,
					realized: "full",
					notes: status.notes,
				},
			});
		} catch {
			return reconciliation(
				facts,
				"pending routing health remains unconfirmed",
			);
		}
		if (
			!routingHealthObservationReady(health, {
				backendId: state.pendingBackendId,
				planId: state.pendingPlanId,
				appliedAtMs: state.pendingStartedAtMs,
				nowMs: Date.parse(clock()),
				minimumSeconds: options.cutover?.minObservationSeconds ?? 0,
				maximumAgeSeconds: options.cutover?.maxObservationAgeSeconds ?? 30,
			})
		)
			return reconciliation(
				facts,
				"pending routing health or dwell evidence remains unconfirmed",
			);
		const restored = state.pendingPhase === "restore";
		const target = state.pendingBackendId;
		const nowMs = Date.parse(clock());
		await checkpoint({
			...clearPending(),
			incumbentBackendId: target,
			lastSwapAtMs: nowMs,
			swapTimesMs: restored ? state.swapTimesMs : [...state.swapTimesMs, nowMs],
		});
		return restored
			? { action: "rolled-back", reasons: [], selectedBackendId: target, facts }
			: { action: "noop", reason: "incumbent-optimal", facts };
	}
	return {
		handleSignal: (signal) => serialized(() => handle(signal)),
		reconcilePending: () => serialized(reconcilePending),
		incumbent: () => state.incumbentBackendId,
		revision: () => state.revision,
		snapshot: () => structuredClone(state),
	};
}
