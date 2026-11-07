// External routing mutations have noRollback effects: an ambiguous response
// requires observation/reconciliation, never a blind retry or a claimed undo.

import { createHash } from "node:crypto";
import {
	applyResilienceProfile,
	createEffectSpec,
	createEffectTracer,
	createResilienceProfile,
} from "@hobo/contracts";
import type {
	ApplyResult,
	MinAvailabilitySpec,
	PolicyDecision,
	ResiliencySpec,
	RoutingPlan,
	RoutingPlanId,
	TrafficRoutingPort,
} from "@hobo/core";
import { parseMinAvailabilitySpec, parseRoutingPlan } from "@hobo/core";
import type { DispatchFact } from "@hobo/dispatcher";
import type { CutoverHealthObservationRecord } from "../_generated/routing_control_pb.js";
import type {
	CutoverPreconditionRecord,
	CutoverTtlPrecondition as CutoverTtlWire,
	CutoverValidation,
} from "../_generated/traffic_cutover_pb.js";
import { cloneAsJson, type JsonBag } from "../json.js";
import {
	type RoutingSynthesisDenial,
	type RoutingTopology,
	synthesizeRoutingPlan,
} from "./synthesize.js";

export const CUTOVER_EVENTS = Object.freeze({
	Refused: "domain.CutoverRefused",
	TtlLowered: "domain.TtlLowered",
	Started: "domain.CutoverStarted",
	RampAdvanced: "routing.RampAdvanced",
	RoutingChanged: "domain.RoutingChanged",
	RolledBack: "domain.RolledBack",
	ReconciliationRequired: "routing.ReconciliationRequired",
	ApplyRequested: "routing.ApplyRequested",
	Observed: "routing.Observed",
} as const);
export const DEFAULT_RAMP_STEPS: readonly number[] = Object.freeze([
	10, 50, 100,
]);
export const DEFAULT_CONSECUTIVE_FAILURES_TO_ROLLBACK = 1;
export const routingCutoverEffects = createEffectSpec({
	purity: "noRollback",
	capabilities: ["decides", "suspends"],
	domains: ["network", "externalCall", "policyEval", "eventEmit", "clock"],
});
// The existing applicator enforces attempts, not wall-clock deadlines. Mutation
// retries are forbidden; durable supervision owns deadlines and reconciliation.
export const routingMutationResilience = createResilienceProfile({
	id: "routing-mutation-once",
	strategies: [
		{
			kind: "retry",
			seed: "routing-mutation",
			maxAttempts: 1,
			baseDelayMs: 0,
			maxDelayMs: 0,
			retryOn: "transient-only",
		},
	],
});
export const routingObservationResilience = createResilienceProfile({
	id: "routing-observation",
	strategies: [
		{
			kind: "retry",
			seed: "routing-observation",
			maxAttempts: 3,
			baseDelayMs: 0,
			maxDelayMs: 0,
			retryOn: "transient-only",
		},
	],
});
export type CutoverHealthObservation = Readonly<
	Pick<
		CutoverHealthObservationRecord,
		"healthy" | "observedAt" | "observationId" | "backendId" | "planId"
	>
>;
/** The callback is an observation boundary; structured evidence is mandatory
 * when minObservationSeconds is declared. It must not replay provider writes. */
export type CutoverHealthGate = (input: {
	percent: number;
	phase: "ramp" | "restore";
	backendId: string;
	plan: RoutingPlan;
	applyResult: ApplyResult;
}) =>
	| boolean
	| CutoverHealthObservation
	| Promise<boolean | CutoverHealthObservation>;
function isBooleanHealthObservation(
	observation: boolean | CutoverHealthObservation,
): observation is boolean {
	// Legacy trusted callbacks return booleans; distinguish that wire variant at the health I/O boundary.
	// oxlint-disable-next-line anti-slop/no-runtime-typeof
	return typeof observation === "boolean";
}
export function routingHealthObservationReady(
	observation: boolean | CutoverHealthObservation,
	context: {
		backendId: string;
		planId: string;
		appliedAtMs: number;
		nowMs: number;
		minimumSeconds: number;
		maximumAgeSeconds?: number;
	},
): boolean {
	const maximumAgeSeconds = context.maximumAgeSeconds ?? 30;
	if (
		![
			context.appliedAtMs,
			context.nowMs,
			context.minimumSeconds,
			maximumAgeSeconds,
		].every(Number.isFinite) ||
		context.minimumSeconds < 0 ||
		maximumAgeSeconds <= 0
	)
		return false;
	if (isBooleanHealthObservation(observation))
		return context.minimumSeconds === 0 && observation;
	const observedAt = Date.parse(observation.observedAt);
	return (
		observation.healthy &&
		observation.backendId === context.backendId &&
		observation.planId === context.planId &&
		observation.observationId !== "" &&
		Number.isFinite(observedAt) &&
		observedAt >= context.appliedAtMs + context.minimumSeconds * 1000 &&
		observedAt >= context.nowMs - maximumAgeSeconds * 1000 &&
		observedAt <= context.nowMs
	);
}
export type CutoverTtlPrecondition = Readonly<
	Pick<
		CutoverTtlWire,
		"previousTtlSeconds" | "loweredTtlSeconds" | "waitedSeconds"
	>
>;
// domain-view: required/optional authoring refinements of the generated wire.
export type CutoverPrecondition = Readonly<
	Omit<
		Pick<
			CutoverPreconditionRecord,
			"validation" | "ttl" | "incumbentPlanId" | "mechanism"
		>,
		"validation" | "ttl" | "incumbentPlanId" | "mechanism"
	> & {
		validation: Readonly<
			Pick<CutoverValidation, "status"> &
				Partial<Pick<CutoverValidation, "changeId">>
		>;
		mechanism?: "weighted" | "dns";
		ttl?: CutoverTtlPrecondition;
		incumbentPlanId?: RoutingPlanId;
		incumbentPlan?: RoutingPlan;
	}
>;

export interface RoutingCutoverOptions {
	topology: RoutingTopology;
	policyDecision: PolicyDecision;
	port: TrafficRoutingPort;
	fromBackendId: string;
	toBackendId: string;
	availability?: MinAvailabilitySpec;
	resiliency?: ResiliencySpec;
	rampSteps?: readonly number[];
	healthGate?: CutoverHealthGate;
	restorationHealthGate?: CutoverHealthGate;
	consecutiveFailuresToRollback?: number;
	precondition?: CutoverPrecondition;
	minObservationSeconds?: number;
	/** Structured health evidence must be this recent at acceptance (default 30s). */
	maxObservationAgeSeconds?: number;
	clock?: () => string;
	planIdPrefix?: string;
	onFact?: (fact: DispatchFact) => void;
	/** Durable supervisor checkpoints the intent before the external write. */
	beforeApply?: (
		plan: RoutingPlan,
		phase: "ramp" | "restore",
		percent: number,
	) => Promise<void>;
}
type Reason = RoutingSynthesisDenial | { code: string; message: string };
type CutoverReconciliationDetails = {
	service: string;
	reasons: readonly Reason[];
	percent: number;
	planId?: string;
	observedAt: string;
};
type CutoverDnsEvidence = { effectiveRtoSeconds?: number };
type CutoverRestorationEvidence = {
	restorationOfPlanId?: string;
	restorationPlanHash?: string;
};
export type RoutingCutoverResult = Readonly<{
	ok: boolean;
	cutover: boolean;
	rolledBack: boolean;
	refused: boolean;
	recoveryPending: boolean;
	finalPercent: number;
	plans: readonly RoutingPlan[];
	finalApplyResult?: ApplyResult;
	pendingPlanId?: string;
	reasons: readonly Reason[];
	facts: readonly DispatchFact[];
}>;

export async function executeRoutingCutover(
	options: RoutingCutoverOptions,
): Promise<RoutingCutoverResult> {
	const clock = options.clock ?? (() => new Date().toISOString());
	const rampSteps = options.rampSteps ?? DEFAULT_RAMP_STEPS;
	const facts: DispatchFact[] = [];
	const plans: RoutingPlan[] = [];
	const prefix =
		options.planIdPrefix ??
		`cutover:${options.topology.service}:${options.toBackendId}`;
	const emit = (fact: DispatchFact) => {
		facts.push(fact);
		options.onFact?.(fact);
	};
	const tracer = createEffectTracer({
		record: (fact) => emit({ type: fact.type, data: { ...fact } }),
	});
	const finish = (input: {
		ok: boolean;
		cutover?: boolean;
		rolledBack?: boolean;
		refused?: boolean;
		recoveryPending?: boolean;
		finalPercent: number;
		finalApplyResult?: ApplyResult;
		pendingPlanId?: string;
		reasons?: readonly Reason[];
	}): RoutingCutoverResult =>
		Object.freeze({
			...input,
			cutover: input.cutover ?? false,
			rolledBack: input.rolledBack ?? false,
			refused: input.refused ?? false,
			recoveryPending: input.recoveryPending ?? false,
			plans: Object.freeze([...plans]),
			facts: Object.freeze([...facts]),
			reasons: Object.freeze([...(input.reasons ?? [])]),
		});
	const refuse = (code: string, message: string) => {
		const reasons = [{ code, message }];
		emit({
			type: CUTOVER_EVENTS.Refused,
			data: {
				service: options.topology.service,
				fromBackendId: options.fromBackendId,
				toBackendId: options.toBackendId,
				reasons,
				refusedAt: clock(),
			},
		});
		return finish({ ok: false, refused: true, finalPercent: 0, reasons });
	};
	const pending = (
		code: string,
		message: string,
		percent: number,
		plan?: RoutingPlan,
	) => {
		const reasons = [{ code, message }];
		const data: CutoverReconciliationDetails = {
			service: options.topology.service,
			reasons,
			percent,
			observedAt: clock(),
		};
		if (plan) data.planId = plan.planId;
		emit({
			type: CUTOVER_EVENTS.ReconciliationRequired,
			data,
		});
		const result: Parameters<typeof finish>[0] = {
			ok: false,
			recoveryPending: true,
			finalPercent: percent,
			reasons,
		};
		if (plan) result.pendingPlanId = plan.planId;
		return finish(result);
	};
	if (
		rampSteps.length === 0 ||
		rampSteps.some(
			(p, i) =>
				!Number.isInteger(p) ||
				p <= 0 ||
				p > 100 ||
				p <= (rampSteps[i - 1] ?? 0),
		) ||
		rampSteps.at(-1) !== 100
	)
		return refuse(
			"invalid-ramp",
			"rampSteps must be ascending integers in (0,100] ending at 100",
		);
	const failuresToRollback =
		options.consecutiveFailuresToRollback ??
		DEFAULT_CONSECUTIVE_FAILURES_TO_ROLLBACK;
	if (!Number.isInteger(failuresToRollback) || failuresToRollback <= 0)
		return refuse(
			"invalid-hysteresis",
			"consecutiveFailuresToRollback must be a positive integer",
		);
	const minObservationSeconds = options.minObservationSeconds ?? 0;
	if (!Number.isFinite(minObservationSeconds) || minObservationSeconds < 0)
		return refuse(
			"invalid-observation-window",
			"minObservationSeconds must be non-negative",
		);
	const maxObservationAgeSeconds = options.maxObservationAgeSeconds ?? 30;
	if (
		!Number.isFinite(maxObservationAgeSeconds) ||
		maxObservationAgeSeconds <= 0
	)
		return refuse(
			"invalid-observation-freshness",
			"maxObservationAgeSeconds must be positive",
		);
	const from = options.topology.backends.find(
		(b) => b.id === options.fromBackendId,
	);
	const to = options.topology.backends.find(
		(b) => b.id === options.toBackendId,
	);
	if (!from || !to || from.id === to.id)
		return refuse(
			"unknown-backend",
			"cutover requires distinct source and destination backends in the topology",
		);
	const precondition = options.precondition;
	if (!precondition)
		return refuse(
			"precondition-missing",
			"cutover requires a validated adapter-specific prerequisite",
		);
	if (precondition.validation.status !== "validated")
		return refuse(
			"validation-unvalidated",
			`cutover requires a validated domain change, got "${precondition.validation.status}"`,
		);
	if (!options.beforeApply)
		return refuse(
			"financial-supervisor-required",
			"cutover requires financial admission and a durable intent checkpoint before provider effects",
		);
	if (!options.healthGate)
		return refuse(
			"health-gate-missing",
			"cutover requires an explicit destination health observation gate",
		);
	const restorationHealthGate = options.restorationHealthGate;
	if (!restorationHealthGate)
		return refuse(
			"restoration-health-gate-missing",
			"cutover requires a source readiness observation for compensation",
		);
	const ttl = precondition.ttl;
	const dns = precondition.mechanism === "dns" || ttl !== undefined;
	if (dns) {
		if (!ttl)
			return refuse(
				"ttl-missing",
				"DNS cutover requires resolver-cache evidence",
			);
		for (const [field, value] of Object.entries(ttl))
			if (!Number.isInteger(value) || value <= 0)
				return refuse("ttl-invalid", `${field} must be a positive integer`);
		if (ttl.loweredTtlSeconds >= ttl.previousTtlSeconds)
			return refuse(
				"ttl-not-lowered",
				"lowered TTL must be below previous TTL",
			);
		if (ttl.waitedSeconds < ttl.previousTtlSeconds)
			return refuse("ttl-wait-incomplete", "previous TTL has not elapsed");
		emit({
			type: CUTOVER_EVENTS.TtlLowered,
			data: {
				service: options.topology.service,
				...ttl,
				effectiveRtoSeconds: ttl.previousTtlSeconds,
				loweredAt: clock(),
			},
		});
	}
	const observe = async (plan: RoutingPlan) => {
		const observed = await applyResilienceProfile({
			profile: routingObservationResilience,
			now: clock,
			op: () => options.port.status(plan.planId),
		});
		for (const fact of observed.facts)
			emit({ type: fact.type, data: { ...fact, planId: plan.planId } });
		return (
			observed.ok &&
			observed.value?.planId === plan.planId &&
			observed.value?.active === true &&
			observed.value.realized === "full"
		);
	};
	const incumbentPlanId = precondition.incumbentPlanId;
	if (!precondition.incumbentPlan || !incumbentPlanId)
		return refuse(
			"incumbent-artifact-missing",
			"cutover requires the exact prior realized routing plan and its expected identity",
		);
	let priorPlan: RoutingPlan;
	try {
		priorPlan = parseRoutingPlan(cloneAsJson(precondition.incumbentPlan));
	} catch {
		return refuse(
			"incumbent-artifact-invalid",
			"prior routing plan is invalid",
		);
	}
	if (
		priorPlan.planId !== incumbentPlanId ||
		priorPlan.intent.service !== options.topology.service ||
		priorPlan.intent.tenantId !== options.topology.tenantId ||
		priorPlan.stationId !== options.topology.stationId ||
		priorPlan.railHash !== options.topology.railHash ||
		!priorPlan.backends.some((backend) => backend.id === from.id) ||
		priorPlan.backends.some(
			(backend) =>
				!options.topology.backends.some(
					(candidate) => candidate.id === backend.id,
				),
		)
	)
		return refuse(
			"incumbent-artifact-scope-mismatch",
			"prior routing plan is not the expected live tenant/service/Station/Rail artifact",
		);
	const priorAvailability = priorPlan.intent.availability;
	if (
		priorAvailability?.locationLabels &&
		options.availability?.locationLabels &&
		JSON.stringify(priorAvailability.locationLabels) !==
			JSON.stringify(options.availability.locationLabels)
	)
		return refuse(
			"availability-context-changed",
			"location grouping changed; a new approved transition is required",
		);
	const minimumHealthy = Math.max(
		priorAvailability?.minHealthyBackends ?? 0,
		options.availability?.minHealthyBackends ?? 0,
	);
	const minimumLocations = Math.max(
		priorAvailability?.minDistinctLocations ?? 0,
		options.availability?.minDistinctLocations ?? 0,
	);
	const locationLabels =
		options.availability?.locationLabels ?? priorAvailability?.locationLabels;
	const combinedAvailability: JsonBag = {};
	if (minimumHealthy) combinedAvailability.minHealthyBackends = minimumHealthy;
	if (minimumLocations)
		combinedAvailability.minDistinctLocations = minimumLocations;
	if (locationLabels) combinedAvailability.locationLabels = [...locationLabels];
	const availability =
		priorAvailability || options.availability
			? parseMinAvailabilitySpec(combinedAvailability)
			: undefined;
	if (
		priorPlan.intent.resiliency &&
		options.resiliency &&
		JSON.stringify(priorPlan.intent.resiliency) !==
			JSON.stringify(options.resiliency)
	)
		return refuse(
			"resiliency-context-changed",
			"resiliency changed; a new approved transition is required",
		);
	const resiliency = options.resiliency ?? priorPlan.intent.resiliency;
	const constraints: Pick<
		RoutingCutoverOptions,
		"availability" | "resiliency"
	> = {};
	if (availability) constraints.availability = availability;
	if (resiliency) constraints.resiliency = resiliency;
	const restorationHash = `sha256:${createHash("sha256").update(JSON.stringify(priorPlan)).digest("hex")}`;
	const incumbent = await applyResilienceProfile({
		profile: routingObservationResilience,
		now: clock,
		op: () => options.port.status(incumbentPlanId),
	});
	if (!incumbent.ok)
		return refuse(
			"incumbent-observation-failed",
			"cannot establish current incumbent before cutover",
		);
	if (
		incumbent.value?.planId !== incumbentPlanId ||
		!incumbent.value?.active ||
		incumbent.value.realized !== "full"
	)
		return refuse(
			"incumbent-not-live",
			"incumbent plan is not active and fully realized",
		);
	const synthesizeAt = (percent: number) => {
		const backends =
			percent === 0
				? priorPlan.backends.map((backend) => {
						const healthy = options.topology.backends.find(
							(candidate) => candidate.id === backend.id,
						)?.healthy;
						if (healthy === undefined) return { ...backend };
						return { ...backend, healthy };
					})
				: percent >= 100
					? [{ ...to, weight: 100 }]
					: [
							{ ...from, weight: 100 - percent },
							{ ...to, weight: percent },
						];
		const validation = synthesizeRoutingPlan({
			topology: { ...options.topology, backends },
			policyDecision: options.policyDecision,
			...constraints,
			now: clock(),
			planId: `${prefix}:p${percent}`,
			weightStrategy: "static",
		});
		if (percent !== 0 || validation.kind === "denied") return validation;
		return {
			kind: "plan" as const,
			plan: parseRoutingPlan(
				cloneAsJson({
					...priorPlan,
					planId: `${prefix}:p0`,
					createdAt: clock(),
					intent: { ...priorPlan.intent, ...constraints },
				}),
			),
		};
	};
	// Reject an infeasible final shape before the first external effect.
	const finalPlan = synthesizeAt(100);
	if (finalPlan.kind === "denied")
		return refuse(
			"final-constraints-unsatisfied",
			finalPlan.reasons.map((r) => r.message).join("; "),
		);
	const dnsEvidence: CutoverDnsEvidence = {};
	if (ttl) dnsEvidence.effectiveRtoSeconds = ttl.previousTtlSeconds;
	emit({
		type: CUTOVER_EVENTS.Started,
		data: {
			service: options.topology.service,
			fromBackendId: from.id,
			toBackendId: to.id,
			rampSteps,
			validationChangeId: precondition.validation.changeId ?? "",
			...dnsEvidence,
			startedAt: clock(),
		},
	});
	const apply = async (
		plan: RoutingPlan,
		phase: "ramp" | "restore",
		percent: number,
	) => {
		plans.push(plan);
		await options.beforeApply?.(plan, phase, percent);
		const restorationEvidence: CutoverRestorationEvidence = {};
		if (phase === "restore") {
			restorationEvidence.restorationOfPlanId = priorPlan.planId;
			restorationEvidence.restorationPlanHash = restorationHash;
		}
		emit({
			type: CUTOVER_EVENTS.ApplyRequested,
			data: {
				service: options.topology.service,
				planId: plan.planId,
				phase,
				...restorationEvidence,
				effects: { ...routingCutoverEffects },
				requestedAt: clock(),
			},
		});
		tracer.invoked({
			contractId: plan.planId,
			channel: "traffic-routing.apply",
			effects: routingCutoverEffects,
			at: clock(),
		});
		const applied = await applyResilienceProfile({
			profile: routingMutationResilience,
			now: clock,
			op: () => options.port.apply(plan),
		});
		for (const fact of applied.facts)
			emit({ type: fact.type, data: { ...fact, planId: plan.planId } });
		return applied;
	};
	const rollback = async (reasons: readonly Reason[], percent: number) => {
		const synthesis = synthesizeAt(0);
		if (synthesis.kind === "denied")
			return pending(
				"restoration-constraints-unsatisfied",
				synthesis.reasons.map((r) => r.message).join("; "),
				percent,
			);
		let restored: Awaited<ReturnType<typeof apply>>;
		try {
			restored = await apply(synthesis.plan, "restore", 0);
		} catch {
			return pending(
				"restoration-checkpoint-failed",
				"restoration intent could not be checkpointed",
				percent,
				synthesis.plan,
			);
		}
		if (
			!restored.ok ||
			!restored.value ||
			restored.value.planId !== synthesis.plan.planId ||
			restored.value.provider !== options.port.provider ||
			restored.value.realized !== "full" ||
			!(await observe(synthesis.plan))
		)
			return pending(
				"restoration-unconfirmed",
				"source restoration was not observed active and fully realized",
				percent,
				synthesis.plan,
			);
		// Authorization, checkpointing and native writes may take arbitrarily
		// long. Only confirmed realization starts the service observation window.
		const restoreStartedAt = Date.parse(clock());
		let recoveryHealth: Awaited<ReturnType<CutoverHealthGate>>;
		try {
			recoveryHealth = await restorationHealthGate({
				percent: 0,
				phase: "restore",
				backendId: from.id,
				plan: synthesis.plan,
				applyResult: restored.value,
			});
		} catch {
			return pending(
				"restoration-health-unconfirmed",
				"source readiness observation failed",
				percent,
				synthesis.plan,
			);
		}
		const recovered =
			routingHealthObservationReady(recoveryHealth, {
				backendId: from.id,
				planId: synthesis.plan.planId,
				appliedAtMs: restoreStartedAt,
				nowMs: Date.parse(clock()),
				minimumSeconds: minObservationSeconds,
				maximumAgeSeconds: maxObservationAgeSeconds,
			}) &&
			(isBooleanHealthObservation(recoveryHealth) ||
				!seenObservations.has(recoveryHealth.observationId));
		if (!recovered)
			return pending(
				"restoration-health-unconfirmed",
				"source routing was applied but source readiness was not established",
				percent,
				synthesis.plan,
			);
		if (!isBooleanHealthObservation(recoveryHealth))
			seenObservations.add(recoveryHealth.observationId);
		emit({
			type: CUTOVER_EVENTS.Observed,
			data: {
				service: options.topology.service,
				planId: synthesis.plan.planId,
				phase: "restore",
				observedAt: clock(),
			},
		});
		emit({
			type: CUTOVER_EVENTS.RolledBack,
			data: {
				service: options.topology.service,
				fromBackendId: from.id,
				toBackendId: to.id,
				abortedAtPercent: percent,
				reasons,
				...dnsEvidence,
				rolledBackAt: clock(),
			},
		});
		return finish({
			ok: false,
			rolledBack: true,
			finalPercent: 0,
			reasons,
			finalApplyResult: restored.value,
		});
	};
	let lastApply: ApplyResult | undefined;
	let consecutiveFailures = 0;
	let stepIndex = 0;
	const seenObservations = new Set<string>();
	while (stepIndex < rampSteps.length) {
		const percent = rampSteps[stepIndex];
		if (percent === undefined)
			return pending(
				"ramp-state-invalid",
				"ramp step disappeared during execution",
				0,
			);
		const synthesis = synthesizeAt(percent);
		if (synthesis.kind === "denied")
			return rollback(synthesis.reasons, percent);
		let applied: Awaited<ReturnType<typeof apply>>;
		try {
			applied = await apply(synthesis.plan, "ramp", percent);
		} catch {
			return pending(
				"apply-checkpoint-failed",
				"routing intent could not be checkpointed",
				percent,
				synthesis.plan,
			);
		}
		if (!applied.ok || !applied.value)
			return pending(
				"apply-outcome-unknown",
				"provider write failed with an ambiguous outcome; reconcile before retry",
				percent,
				synthesis.plan,
			);
		lastApply = applied.value;
		if (
			lastApply.planId !== synthesis.plan.planId ||
			lastApply.provider !== options.port.provider
		)
			return pending(
				"apply-identity-mismatch",
				"provider acknowledgement does not identify the requested plan and adapter",
				percent,
				synthesis.plan,
			);
		if (lastApply.realized !== "full")
			return rollback(
				[
					{
						code: "apply-degraded",
						message: `provider realized ${lastApply.realized} at ${percent}%`,
					},
				],
				percent,
			);
		if (!(await observe(synthesis.plan)))
			return pending(
				"apply-observation-missing",
				"provider apply was not observed active and fully realized",
				percent,
				synthesis.plan,
			);
		const appliedAt = Date.parse(clock());
		emit({
			type: CUTOVER_EVENTS.Observed,
			data: {
				service: options.topology.service,
				planId: synthesis.plan.planId,
				phase: "ramp",
				observedAt: clock(),
			},
		});
		while (true) {
			let observation: Awaited<ReturnType<CutoverHealthGate>>;
			try {
				observation = await options.healthGate({
					percent,
					phase: "ramp",
					backendId: to.id,
					plan: synthesis.plan,
					applyResult: lastApply,
				});
			} catch {
				return pending(
					"health-outcome-unknown",
					"health observation failed after routing mutation",
					percent,
					synthesis.plan,
				);
			}
			let healthy: boolean;
			if (isBooleanHealthObservation(observation)) {
				if (minObservationSeconds > 0)
					return pending(
						"health-evidence-missing",
						"timed health gate requires timestamped distinct observations",
						percent,
						synthesis.plan,
					);
				healthy = observation;
			} else {
				if (
					seenObservations.has(observation.observationId) ||
					!routingHealthObservationReady(
						{ ...observation, healthy: true },
						{
							backendId: to.id,
							planId: synthesis.plan.planId,
							appliedAtMs: appliedAt,
							nowMs: Date.parse(clock()),
							minimumSeconds: minObservationSeconds,
							maximumAgeSeconds: maxObservationAgeSeconds,
						},
					)
				)
					return pending(
						"health-evidence-stale",
						"health evidence is duplicated, stale, or outside the declared observation window",
						percent,
						synthesis.plan,
					);
				seenObservations.add(observation.observationId);
				healthy = observation.healthy;
			}
			if (!healthy) {
				consecutiveFailures++;
				if (consecutiveFailures >= failuresToRollback)
					return rollback(
						[
							{
								code: "health-gate-failed",
								message: `health gate failed at ${percent}% (${consecutiveFailures} consecutive failure(s), threshold ${failuresToRollback})`,
							},
						],
						percent,
					);
				continue;
			}
			consecutiveFailures = 0;
			break;
		}

		emit({
			type: CUTOVER_EVENTS.RampAdvanced,
			data: {
				service: options.topology.service,
				toBackendId: to.id,
				percent,
				planId: synthesis.plan.planId,
			},
		});
		stepIndex++;
	}
	emit({
		type: CUTOVER_EVENTS.RoutingChanged,
		data: {
			service: options.topology.service,
			fromBackendId: from.id,
			toBackendId: to.id,
			changedAt: clock(),
		},
	});
	const result: Parameters<typeof finish>[0] = {
		ok: true,
		cutover: true,
		finalPercent: 100,
	};
	if (lastApply) result.finalApplyResult = lastApply;
	return finish(result);
}
