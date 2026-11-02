/**
 * Failure → Incident → default A2H | opt-in sandboxed self-heal (ADR-0082 / 0094 / 0076).
 * Self-heal never mutates baseline; successful fix is a proposed Delta only.
 */
import { createHash, randomUUID } from "node:crypto";
import { type JsonObject } from "../json.js";


// public-contract: incident / A2H / self-heal schema.
export const INCIDENT_CD_SCHEMA = "hobo.cd-incident/v1" as const;

export const INCIDENT_EVENTS = Object.freeze({
	Opened: "incident.Opened",
	Escalated: "incident.Escalated",
	A2HHandedOff: "incident.A2HHandedOff",
	SelfHealAttempted: "incident.SelfHealAttempted",
	SelfHealDenied: "incident.SelfHealDenied",
	Resolved: "incident.Resolved",
} as const);

export type IncidentEvent = Readonly<{
	id: string;
	type: (typeof INCIDENT_EVENTS)[keyof typeof INCIDENT_EVENTS];
	schemaVersion: typeof INCIDENT_CD_SCHEMA;
	seq: number;
	time: string;
	data: Readonly<JsonObject>;
}>;

export type FailureSignal =
	| "apply-failed"
	| "analysis-failed"
	| "golden-failed"
	| "slo-burn"
	| "progressive-rollback";

export type SafetyEnvelope = Readonly<{
	schemaVersion: "hobo.safety-envelope/v1";
	/** Estimated blast radius: unknown fails closed to A2H. */
	blastRadius: "none" | "resource" | "camp" | "tenant" | "unknown";
	reversible: boolean;
	spendCapUsd: number;
	estimatedSpendUsd: number;
	selfCausation: boolean;
	maxAttempts: number;
	attemptsUsed: number;
	/** Lane required for any auto/self-heal action. */
	requiresLane: true;
}>;

export type A2HHandoffPackage = Readonly<{
	schemaVersion: typeof INCIDENT_CD_SCHEMA;
	incidentId: string;
	signal: FailureSignal;
	tenant: string;
	environment: string;
	deploymentId: string;
	setId: string;
	/** Secret-free context for humans (refs only). */
	context: Readonly<JsonObject>;
	goldenDiffRef?: string;
	blastRadius: SafetyEnvelope["blastRadius"];
	decisionRequired: string;
	deadline: string;
	obligationId: string;
}>;

export type SelfHealAgentRegistration = Readonly<{
	agentId: string;
	tenant: string;
	scopes: readonly string[];
	policyAllowed: boolean;
}>;

export type LaneGrant = Readonly<{
	laneId: string;
	tenant: string;
	/** Fail-closed membership. */
	membership: "granted";
	forkOnTouch: true;
	baselineSingleWriterLease: false;
	resourceBudget: Readonly<{ cpuMillis: number; memoryMb: number }>;
	externalSideEffects: "mock" | "explicit-grant";
	/** Baseline mutation is never granted. */
	baselineMutation: false;
}>;

export type ProposedDelta = Readonly<{
	deltaId: string;
	incidentId: string;
	laneId: string;
	/** Must re-enter Gatekeeper + Harness — never a direct baseline mutation. */
	promotionPath: "gatekeeper-then-harness";
	summary: string;
	contentHash: `sha256:${string}`;
}>;

export type FailureDisposition =
	| Readonly<{
			kind: "a2h";
			incidentId: string;
			handoff: A2HHandoffPackage;
			events: readonly IncidentEvent[];
	  }>
	| Readonly<{
			kind: "self-heal-lane";
			incidentId: string;
			lane: LaneGrant;
			envelope: SafetyEnvelope;
			/** Fix attempt result inside the lane only. */
			attempt: Readonly<{
				ok: boolean;
				proposedDelta?: ProposedDelta;
				reason: string;
			}>;
			events: readonly IncidentEvent[];
	  }>;

export type FailureDecisionInput = Readonly<{
	signal: FailureSignal;
	tenant: string;
	environment: string;
	deploymentId: string;
	setId: string;
	/** Secret-free context only. */
	context: Readonly<JsonObject>;
	goldenDiffRef?: string;
	envelope: SafetyEnvelope;
	selfHealAgent?: SelfHealAgentRegistration;
	/** Agent attempts fix inside lane when granted. */
	attemptFixInLane?: (lane: LaneGrant) => {
		ok: boolean;
		summary: string;
	};
	now?: () => string;
	deadlineMinutes?: number;
}>;

/**
 * Open Incident and decide A2H vs sandboxed self-heal.
 * Unknown blast radius, non-reversible, over-spend, self-causation, or
 * exhausted attempts → fail closed to A2H.
 */
export function decideFailurePath(
	input: FailureDecisionInput,
): FailureDisposition {
	const now = input.now ?? (() => new Date().toISOString());
	const t = now();
	const incidentId = `inc_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
	const events: IncidentEvent[] = [];
	let seq = 0;
	const emit = (
		type: IncidentEvent["type"],
		data: Readonly<JsonObject>,
	) => {
		seq += 1;
		events.push(
			Object.freeze({
				id: `evt-${type}-${seq}`,
				type,
				schemaVersion: INCIDENT_CD_SCHEMA,
				seq,
				time: t,
				data: Object.freeze({ ...data }),
			}),
		);
	};

	emit(INCIDENT_EVENTS.Opened, {
		incidentId,
		signal: input.signal,
		tenant: input.tenant,
		environment: input.environment,
		deploymentId: input.deploymentId,
		setId: input.setId,
	});

	const a2h = (): FailureDisposition => {
		const deadlineMs = (input.deadlineMinutes ?? 30) * 60 * 1000;
		const deadline = new Date(new Date(t).getTime() + deadlineMs).toISOString();
		const obligationId = `obl:a2h:${incidentId}`;
		const handoff: A2HHandoffPackage = Object.freeze({
			schemaVersion: INCIDENT_CD_SCHEMA,
			incidentId,
			signal: input.signal,
			tenant: input.tenant,
			environment: input.environment,
			deploymentId: input.deploymentId,
			setId: input.setId,
			context: Object.freeze({ ...input.context }),
			...(input.goldenDiffRef !== undefined
				? { goldenDiffRef: input.goldenDiffRef }
				: undefined),
			blastRadius: input.envelope.blastRadius,
			decisionRequired: "human-remediation-or-approve-delta",
			deadline,
			obligationId,
		});
		emit(INCIDENT_EVENTS.A2HHandedOff, {
			incidentId,
			obligationId,
			deadline,
			decisionRequired: handoff.decisionRequired,
		});
		return Object.freeze({
			kind: "a2h" as const,
			incidentId,
			handoff,
			events: Object.freeze(events),
		});
	};

	// Fail closed to A2H when envelope is uncomputable / unsafe.
	if (
		input.envelope.blastRadius === "unknown" ||
		!input.envelope.reversible ||
		input.envelope.estimatedSpendUsd > input.envelope.spendCapUsd ||
		input.envelope.selfCausation ||
		input.envelope.attemptsUsed >= input.envelope.maxAttempts
	) {
		emit(INCIDENT_EVENTS.SelfHealDenied, {
			incidentId,
			reason: "safety-envelope-fail-closed",
			blastRadius: input.envelope.blastRadius,
		});
		return a2h();
	}

	const agent = input.selfHealAgent;
	if (
		!agent?.policyAllowed ||
		agent.tenant !== input.tenant ||
		!agent.scopes.includes(input.environment)
	) {
		return a2h();
	}

	// Grant ADR-0076 lane — never baseline mutation.
	const lane: LaneGrant = Object.freeze({
		laneId: `lane_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
		tenant: input.tenant,
		membership: "granted" as const,
		forkOnTouch: true as const,
		baselineSingleWriterLease: false as const,
		resourceBudget: Object.freeze({ cpuMillis: 500, memoryMb: 256 }),
		externalSideEffects: "mock" as const,
		baselineMutation: false as const,
	});

	emit(INCIDENT_EVENTS.SelfHealAttempted, {
		incidentId,
		agentId: agent.agentId,
		laneId: lane.laneId,
		baselineMutation: false,
	});

	const attempt =
		input.attemptFixInLane?.(lane) ??
		({ ok: false, summary: "no fix attempt provided" } as const);

	if (!attempt.ok) {
		emit(INCIDENT_EVENTS.SelfHealDenied, {
			incidentId,
			reason: attempt.summary,
			laneId: lane.laneId,
		});
		return a2h();
	}

	const deltaBody = {
		incidentId,
		laneId: lane.laneId,
		summary: attempt.summary,
		agentId: agent.agentId,
	};
	const proposedDelta: ProposedDelta = Object.freeze({
		deltaId: `delta_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
		incidentId,
		laneId: lane.laneId,
		promotionPath: "gatekeeper-then-harness" as const,
		summary: attempt.summary,
		contentHash:
			`sha256:${createHash("sha256").update(JSON.stringify(deltaBody)).digest("hex")}` as const,
	});

	return Object.freeze({
		kind: "self-heal-lane" as const,
		incidentId,
		lane,
		envelope: input.envelope,
		attempt: Object.freeze({
			ok: true as const,
			proposedDelta,
			reason: attempt.summary,
		}),
		events: Object.freeze(events),
	});
}

export function createDefaultSafetyEnvelope(
	overrides: Partial<SafetyEnvelope> = {},
): SafetyEnvelope {
	return Object.freeze({
		schemaVersion: "hobo.safety-envelope/v1",
		blastRadius: overrides.blastRadius ?? "resource",
		reversible: overrides.reversible ?? true,
		spendCapUsd: overrides.spendCapUsd ?? 50,
		estimatedSpendUsd: overrides.estimatedSpendUsd ?? 1,
		selfCausation: overrides.selfCausation ?? false,
		maxAttempts: overrides.maxAttempts ?? 3,
		attemptsUsed: overrides.attemptsUsed ?? 0,
		requiresLane: true as const,
	});
}
