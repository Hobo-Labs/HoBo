/**
 * OpenDelivery port (hobo:delivery) — canary / staged rollouts / auto-rollback.
 * Built-in default reuses flag percentage + gateway-weighted traffic signal.
 * External Argo/Flagger adapters are ranked optionals (not required).
 *
 * Staged progressive strategies (ADR-0083 extension):
 * a stage may carry ordered target `groups` executed with bounded `concurrency`,
 * a `maxFailures` halt threshold, `approval` barriers (stage- or group-scoped),
 * and deterministic resume-from-halt (`resumeFrom` on `RolloutState`).
 * Percent-only stages remain the degenerate case — existing records stay valid.
 * Every transition is an event in the engine journal and state is computed by
 * the pure `applyRolloutEvent` reducer, so `replayRolloutJournal` reconstructs
 * identical state from the journal by construction.
 */

import { createHash, randomUUID } from "node:crypto";
import { first, must } from "@hobo/core/total-access";
import type { FeatureFlagStore } from "./feature-flag-store.js";
import { asJsonObject, type JsonObject } from "./json.js";

// public-contract: OpenDelivery port id.
export const DELIVERY_PORT = "hobo:delivery" as const;

// public-contract: rollout event schema.
export const ROLLOUT_EVENT_SCHEMA = "hobo.rollout-events/v1" as const;

export const ROLLOUT_EVENTS = Object.freeze({
	Started: "rollout.Started",
	Stepped: "rollout.Stepped",
	Promoted: "rollout.Promoted",
	RolledBack: "rollout.RolledBack",
	Failed: "rollout.Failed",
	StageStarted: "rollout.StageStarted",
	GroupProgressed: "rollout.GroupProgressed",
	GroupCompleted: "rollout.GroupCompleted",
	StageCompleted: "rollout.StageCompleted",
	ApprovalRequested: "rollout.ApprovalRequested",
	ApprovalGranted: "rollout.ApprovalGranted",
	Halted: "rollout.Halted",
	Resumed: "rollout.Resumed",
} as const);

export type RolloutEvent = Readonly<{
	id: string;
	type: (typeof ROLLOUT_EVENTS)[keyof typeof ROLLOUT_EVENTS];
	schemaVersion: typeof ROLLOUT_EVENT_SCHEMA;
	seq: number;
	time: string;
	data: JsonObject;
}>;

/** Ordered target group executed in parallel (bounded) within a staged stage. */
export type RolloutTargetGroup = Readonly<{
	name: string;
	targets: readonly string[];
	/** Max targets dispatched in parallel within this group (overrides stage). */
	concurrency?: number;
	/** Max failed targets tolerated in this group before halting (overrides stage). */
	maxFailures?: number;
	/** Require an approval barrier before this group starts. */
	approval?: boolean;
}>;

export type RolloutStage = Readonly<{
	percent: number;
	duration?: string;
	analysis?: Readonly<{
		slo?: string;
		golden?: boolean;
		guardrailMetric?: string;
	}>;
	/** Ordered target groups; absent/empty = degenerate percent-only stage. */
	groups?: readonly RolloutTargetGroup[];
	/** Stage-default max parallel targets per group. */
	concurrency?: number;
	/** Stage-default halt threshold (failed targets tolerated per group). */
	maxFailures?: number;
	/** Require an approval barrier before this stage starts. */
	approval?: boolean;
	/** Declarative maintenance-window hint (scheduling is the caller's port). */
	maintenanceWindow?: string;
}>;

export type RolloutPolicy = Readonly<{
	name: string;
	flag: string;
	stages: readonly RolloutStage[];
	traffic: "flag-only" | "gateway-weighted";
	autoRollback: boolean;
	/** Gateway weight signal (0–100) when traffic is gateway-weighted. */
	gatewayWeightPercent?: number;
}>;

/** Recorded position a halted rollout resumes from. */
export type RolloutResumePoint = Readonly<{
	stageIndex: number;
	groupIndex: number;
}>;

/** Pending approval barrier (stage-scoped or group-scoped). */
export type RolloutPendingApproval = Readonly<{
	stageIndex: number;
	groupIndex: number;
	scope: "stage" | "group";
}>;

/** Progress through the ordered groups of the current staged stage. */
export type StagedRolloutProgress = Readonly<{
	groupIndex: number;
	completedTargets: readonly string[];
	failedTargets: readonly string[];
}>;

/** Per-target execution outcome reported back to the engine. */
export type RolloutTargetOutcome = Readonly<{
	target: string;
	ok: boolean;
}>;

export type RolloutState = Readonly<{
	id: string;
	policy: RolloutPolicy;
	status:
		| "running"
		| "promoted"
		| "rolled_back"
		| "failed"
		| "awaiting_approval"
		| "halted";
	stageIndex: number;
	percent: number;
	gatewayWeightPercent: number;
	startedAt: string;
	updatedAt: string;
	reason?: string;
	/** Present while a grouped stage is in progress. */
	staged?: StagedRolloutProgress;
	/** Present while halted (maxFailures exceeded). */
	resumeFrom?: RolloutResumePoint;
	/** Present while awaiting an approval barrier. */
	pendingApproval?: RolloutPendingApproval;
}>;

export type DeliveryHealthSignal = Readonly<{
	sloBurning?: boolean;
	goldenFailed?: boolean;
	guardrailRegressed?: boolean;
}>;

const EMPTY_TARGETS: readonly string[] = Object.freeze([]);

const EMPTY_STAGED_PROGRESS: StagedRolloutProgress = Object.freeze({
	groupIndex: 0,
	completedTargets: EMPTY_TARGETS,
	failedTargets: EMPTY_TARGETS,
});

function isGrouped(stage: RolloutStage | undefined): boolean {
	return (stage?.groups?.length ?? 0) > 0;
}

function baseState(
	prev: RolloutState,
): Omit<RolloutState, "reason" | "staged" | "resumeFrom" | "pendingApproval"> {
	const {
		reason: _reason,
		staged: _staged,
		resumeFrom: _resumeFrom,
		pendingApproval: _pendingApproval,
		...rest
	} = prev;
	return rest;
}

/**
 * Pure reducer: fold one journal event into rollout state. The engine applies
 * the same reducer for every transition, so journal replay is deterministic by
 * construction.
 */
export function applyRolloutEvent(
	prev: RolloutState | undefined,
	event: RolloutEvent,
): RolloutState {
	const d = event.data;
	if (event.type === ROLLOUT_EVENTS.Started) {
		return Object.freeze({
			id: String(d.rolloutId),
			// SAFETY: assertion to `y as RolloutPolicy), s` is required at this boundary.
			// SAFETY: journal policy is restored to RolloutPolicy at this fold.
			policy: freezePolicy(d.policy as never),
			status: "running" as const,
			stageIndex: 0,
			percent: Number(d.percent),
			gatewayWeightPercent: Number(d.gatewayWeightPercent ?? 0),
			startedAt: event.time,
			updatedAt: event.time,
		});
	}
	if (!prev) {
		throw Object.assign(
			new Error(`rollout journal starts mid-stream: ${event.type}`),
			{ code: "rollout-journal-gap" },
		);
	}
	switch (event.type) {
		case ROLLOUT_EVENTS.Stepped:
		case ROLLOUT_EVENTS.StageStarted: {
			const stageIndex = Number(d.stageIndex);
			const stage = prev.policy.stages[stageIndex];
			return Object.freeze({
				...baseState(prev),
				status: "running" as const,
				stageIndex,
				percent: Number(d.percent),
				gatewayWeightPercent: Number(
					d.gatewayWeightPercent ?? prev.gatewayWeightPercent,
				),
				updatedAt: event.time,
				...(isGrouped(stage) ? { staged: EMPTY_STAGED_PROGRESS } : undefined),
			});
		}
		case ROLLOUT_EVENTS.GroupProgressed: {
			const staged = prev.staged ?? EMPTY_STAGED_PROGRESS;
			// SAFETY: assertion to `omes ?? []) as readonly RolloutTargetOutcome[]; co` is required at this boundary.
			const rawOutcomes = d.outcomes ?? [];
			// SAFETY: journal outcomes are restored to RolloutTargetOutcome[].
			const outcomes: readonly RolloutTargetOutcome[] = rawOutcomes as never;
			const completed = [...staged.completedTargets];
			const failed = [...staged.failedTargets];
			for (const o of outcomes) {
				(o.ok ? completed : failed).push(o.target);
			}
			return Object.freeze({
				...baseState(prev),
				staged: Object.freeze({
					groupIndex: staged.groupIndex,
					completedTargets: Object.freeze(completed),
					failedTargets: Object.freeze(failed),
				}),
				updatedAt: event.time,
			});
		}
		case ROLLOUT_EVENTS.GroupCompleted: {
			return Object.freeze({
				...baseState(prev),
				staged: Object.freeze({
					groupIndex: Number(d.groupIndex) + 1,
					completedTargets: EMPTY_TARGETS,
					failedTargets: EMPTY_TARGETS,
				}),
				updatedAt: event.time,
			});
		}
		case ROLLOUT_EVENTS.StageCompleted: {
			return Object.freeze({
				...baseState(prev),
				updatedAt: event.time,
			});
		}
		case ROLLOUT_EVENTS.ApprovalRequested: {
			return Object.freeze({
				...baseState(prev),
				...(prev.staged !== undefined ? { staged: prev.staged } : undefined),
				status: "awaiting_approval" as const,
				pendingApproval: Object.freeze({
					stageIndex: Number(d.stageIndex),
					groupIndex: Number(d.groupIndex ?? 0),
					// SAFETY: assertion to `e === "group" ? "group" : "stage") as "stage" | "group", }` is required at this boundary.
					scope: (d.scope === "group" ? "group" : "stage") as "stage" | "group",
				}),
				updatedAt: event.time,
			});
		}
		case ROLLOUT_EVENTS.ApprovalGranted: {
			return Object.freeze({
				...baseState(prev),
				...(prev.staged !== undefined ? { staged: prev.staged } : undefined),
				status: "running" as const,
				updatedAt: event.time,
			});
		}
		case ROLLOUT_EVENTS.Halted: {
			return Object.freeze({
				...baseState(prev),
				...(prev.staged !== undefined ? { staged: prev.staged } : undefined),
				status: "halted" as const,
				resumeFrom: Object.freeze({
					stageIndex: Number(d.stageIndex),
					groupIndex: Number(d.groupIndex),
				}),
				reason: String(d.reason ?? "halted"),
				updatedAt: event.time,
			});
		}
		case ROLLOUT_EVENTS.Resumed: {
			return Object.freeze({
				...baseState(prev),
				staged: Object.freeze({
					groupIndex: Number(d.groupIndex),
					completedTargets: prev.staged?.completedTargets ?? EMPTY_TARGETS,
					failedTargets: EMPTY_TARGETS,
				}),
				status: "running" as const,
				updatedAt: event.time,
			});
		}
		case ROLLOUT_EVENTS.Promoted: {
			return Object.freeze({
				...baseState(prev),
				status: "promoted" as const,
				percent: 100,
				gatewayWeightPercent:
					prev.policy.traffic === "gateway-weighted"
						? 100
						: prev.gatewayWeightPercent,
				updatedAt: event.time,
			});
		}
		case ROLLOUT_EVENTS.RolledBack: {
			return Object.freeze({
				...baseState(prev),
				status: "rolled_back" as const,
				percent: 0,
				gatewayWeightPercent: 0,
				updatedAt: event.time,
				reason: JSON.stringify(d.reason),
			});
		}
		case ROLLOUT_EVENTS.Failed: {
			return Object.freeze({
				...baseState(prev),
				status: "failed" as const,
				updatedAt: event.time,
				reason: String(d.reason ?? "failed"),
			});
		}
		default: {
			throw Object.assign(
				new Error(`unknown rollout event: ${String(event.type)}`),
				{ code: "rollout-unknown-event" },
			);
		}
	}
}

/**
 * Deterministic journal replay: fold a rollout event journal back into the
 * per-rollout states the engine held when it emitted those events.
 */
export function replayRolloutJournal(
	events: readonly RolloutEvent[],
): ReadonlyMap<string, RolloutState> {
	const states = new Map<string, RolloutState>();
	for (const event of events) {
		const rolloutId = String(event.data.rolloutId);
		states.set(rolloutId, applyRolloutEvent(states.get(rolloutId), event));
	}
	return states;
}

/**
 * Built-in OpenDelivery engine: advances flag percentage through stages,
 * optionally mirrors gateway weight, auto-rollbacks on health signals.
 * Grouped stages walk their target groups in order via nextBatch/
 * reportOutcomes, halt on maxFailures, pause at approval barriers, and resume
 * deterministically from the journal.
 */
export class OpenDeliveryEngine {
	readonly events: RolloutEvent[] = [];
	private seq = 0;
	private readonly rollouts = new Map<string, RolloutState>();
	private readonly now: () => string;
	private readonly store: FeatureFlagStore;

	constructor(options: {
		readonly store: FeatureFlagStore;
		readonly now?: () => string;
	}) {
		this.store = options.store;
		this.now = options.now ?? (() => new Date().toISOString());
	}

	list(): readonly RolloutState[] {
		return Object.freeze([...this.rollouts.values()]);
	}

	get(id: string): RolloutState | undefined {
		return this.rollouts.get(id);
	}

	start(policy: RolloutPolicy): RolloutState {
		if (!policy.stages.length) {
			throw new TypeError("rollout requires at least one stage");
		}
		for (const stage of policy.stages) {
			for (const group of stage.groups ?? []) {
				if (!group.targets.length) {
					throw new TypeError(
						`rollout group requires at least one target: ${group.name}`,
					);
				}
			}
		}
		const frozen = freezePolicy(policy);
		const id = `rollout_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
		const stage0 = first(frozen.stages);
		// Degenerate percent-ramp start keeps the pre-staged behavior byte-for-byte.
		const legacyStart = !isGrouped(stage0) && stage0.approval !== true;
		const startPercent = legacyStart ? clamp(stage0.percent) : 0;
		const startWeight =
			legacyStart && frozen.traffic === "gateway-weighted"
				? clamp(frozen.gatewayWeightPercent ?? stage0.percent)
				: 0;
		this.transition(ROLLOUT_EVENTS.Started, {
			rolloutId: id,
			flag: frozen.flag,
			percent: startPercent,
			traffic: frozen.traffic,
			gatewayWeightPercent: startWeight,
			policy: frozen,
		});
		if (legacyStart) {
			this.applyFlagPercent(frozen.flag, startPercent);
			return this.require(id);
		}
		if (stage0.approval === true) {
			// Barrier before anything ramps: stay dark until granted.
			return this.transition(ROLLOUT_EVENTS.ApprovalRequested, {
				rolloutId: id,
				stageIndex: 0,
				groupIndex: 0,
				scope: "stage",
			});
		}
		return this.enterStage(id, 0);
	}

	/**
	 * Advance to next stage or promote. Auto-rollback when health fails and
	 * policy.autoRollback is true (durable obligation shape).
	 */
	step(rolloutId: string, health: DeliveryHealthSignal = {}): RolloutState {
		const prev = this.require(rolloutId);
		if (prev.status !== "running") return prev;

		if (
			prev.policy.autoRollback &&
			(health.sloBurning || health.goldenFailed || health.guardrailRegressed)
		) {
			return this.rollback(rolloutId, {
				sloBurning: health.sloBurning === true,
				goldenFailed: health.goldenFailed === true,
				guardrailRegressed: health.guardrailRegressed === true,
			});
		}

		if (prev.staged !== undefined) {
			throw Object.assign(
				new Error(
					`staged stage in progress — drive it with nextBatch/reportOutcomes: ${rolloutId}`,
				),
				{ code: "rollout-staged-pending" },
			);
		}

		const nextIndex = prev.stageIndex + 1;
		if (nextIndex >= prev.policy.stages.length) {
			return this.promote(rolloutId);
		}
		const stage = must(
			prev.policy.stages[nextIndex],
			"prev.policy.stages[nextIndex]",
		);
		if (stage.approval === true) {
			return this.transition(ROLLOUT_EVENTS.ApprovalRequested, {
				rolloutId,
				stageIndex: nextIndex,
				groupIndex: 0,
				scope: "stage",
			});
		}
		return this.enterStage(rolloutId, nextIndex);
	}

	/**
	 * Next targets to execute in the current group, capped by the effective
	 * concurrency (group override, else stage default, else unbounded).
	 */
	nextBatch(rolloutId: string): readonly string[] {
		const state = this.require(rolloutId);
		if (state.status !== "running" || state.staged === undefined) {
			return EMPTY_TARGETS;
		}
		const stage = state.policy.stages[state.stageIndex];
		const group = stage?.groups?.[state.staged.groupIndex];
		if (!group) return EMPTY_TARGETS;
		const seen = new Set([
			...state.staged.completedTargets,
			...state.staged.failedTargets,
		]);
		const pending = group.targets.filter((t) => !seen.has(t));
		const limit = normalizeConcurrency(group.concurrency ?? stage?.concurrency);
		return Object.freeze(pending.slice(0, limit));
	}

	/**
	 * Fold execution outcomes for the current group: records progress, halts
	 * when failures exceed the effective maxFailures, completes groups/stages
	 * in order, pauses at approval barriers, promotes after the final stage.
	 */
	reportOutcomes(
		rolloutId: string,
		outcomes: readonly RolloutTargetOutcome[],
	): RolloutState {
		const prev = this.require(rolloutId);
		if (prev.status !== "running" || prev.staged === undefined) {
			throw Object.assign(
				new Error(`rollout has no staged group in progress: ${rolloutId}`),
				{ code: "rollout-staged-inactive" },
			);
		}
		const stageIndex = prev.stageIndex;
		const stage = must(
			prev.policy.stages[stageIndex],
			"prev.policy.stages[stageIndex]",
		);
		const groups = stage.groups ?? [];
		const groupIndex = prev.staged.groupIndex;
		const group = groups[groupIndex];
		if (!group) {
			throw Object.assign(
				new Error(`rollout group out of range: ${rolloutId}`),
				{ code: "rollout-group-missing" },
			);
		}
		const seen = new Set([
			...prev.staged.completedTargets,
			...prev.staged.failedTargets,
		]);
		const relevant: RolloutTargetOutcome[] = [];
		for (const o of outcomes) {
			if (!group.targets.includes(o.target) || seen.has(o.target)) continue;
			seen.add(o.target);
			relevant.push(Object.freeze({ target: o.target, ok: o.ok === true }));
		}
		if (!relevant.length) return prev;

		let state = this.transition(ROLLOUT_EVENTS.GroupProgressed, {
			rolloutId,
			stageIndex,
			groupIndex,
			outcomes: Object.freeze(relevant),
		});
		const failed = must(state.staged).failedTargets;
		const maxFailures = group.maxFailures ?? stage.maxFailures ?? 0;
		if (failed.length > maxFailures) {
			return this.transition(ROLLOUT_EVENTS.Halted, {
				rolloutId,
				stageIndex,
				groupIndex,
				failedTargets: failed,
				maxFailures,
				reason: "max-failures-exceeded",
			});
		}
		const settled =
			must(state.staged).completedTargets.length + failed.length >=
			group.targets.length;
		if (!settled) return state;

		state = this.transition(ROLLOUT_EVENTS.GroupCompleted, {
			rolloutId,
			stageIndex,
			groupIndex,
			group: group.name,
			failedTargets: failed,
		});
		const nextGroup = groups[must(state.staged).groupIndex];
		if (nextGroup) {
			if (nextGroup.approval === true) {
				return this.transition(ROLLOUT_EVENTS.ApprovalRequested, {
					rolloutId,
					stageIndex,
					groupIndex: must(state.staged).groupIndex,
					scope: "group",
				});
			}
			return state;
		}

		state = this.transition(ROLLOUT_EVENTS.StageCompleted, {
			rolloutId,
			stageIndex,
			percent: state.percent,
		});
		const nextIndex = stageIndex + 1;
		if (nextIndex >= prev.policy.stages.length) {
			return this.promote(rolloutId);
		}
		const nextStage = must(
			prev.policy.stages[nextIndex],
			"prev.policy.stages[nextIndex]",
		);
		if (nextStage.approval === true) {
			return this.transition(ROLLOUT_EVENTS.ApprovalRequested, {
				rolloutId,
				stageIndex: nextIndex,
				groupIndex: 0,
				scope: "stage",
			});
		}
		return this.enterStage(rolloutId, nextIndex);
	}

	/**
	 * Satisfy a pending approval barrier. The barrier itself is decided
	 * upstream (policy require-approval via Gatekeeper / A2H) — this engine
	 * only records the grant and continues; it never invents an approval plane.
	 */
	grantApproval(rolloutId: string, approver: string): RolloutState {
		const prev = this.require(rolloutId);
		if (
			prev.status !== "awaiting_approval" ||
			prev.pendingApproval === undefined
		) {
			throw Object.assign(
				new Error(`rollout has no pending approval: ${rolloutId}`),
				{ code: "rollout-approval-not-pending" },
			);
		}
		const pending = prev.pendingApproval;
		const state = this.transition(ROLLOUT_EVENTS.ApprovalGranted, {
			rolloutId,
			stageIndex: pending.stageIndex,
			groupIndex: pending.groupIndex,
			scope: pending.scope,
			approver,
		});
		if (pending.scope === "stage") {
			return this.enterStage(rolloutId, pending.stageIndex);
		}
		return state;
	}

	/** Continue a halted rollout from its recorded position (failed targets retry). */
	resume(rolloutId: string): RolloutState {
		const prev = this.require(rolloutId);
		if (prev.status !== "halted" || prev.resumeFrom === undefined) {
			throw Object.assign(new Error(`rollout is not halted: ${rolloutId}`), {
				code: "rollout-not-halted",
			});
		}
		return this.transition(ROLLOUT_EVENTS.Resumed, {
			rolloutId,
			stageIndex: prev.resumeFrom.stageIndex,
			groupIndex: prev.resumeFrom.groupIndex,
		});
	}

	rollback(
		rolloutId: string,
		reason: Readonly<Record<string, boolean | string>>,
	): RolloutState {
		const prev = this.require(rolloutId);
		const rolled = this.transition(ROLLOUT_EVENTS.RolledBack, {
			rolloutId,
			flag: prev.policy.flag,
			reason,
			obligation: "auto-rollback",
		});
		this.applyFlagPercent(prev.policy.flag, 0);
		// Kill-switch fast path for safety
		this.store.activateKillSwitch(prev.policy.flag, "open-delivery-rollback");
		return rolled;
	}

	/** Gateway weight signal for ADR-0035 weighted routing composition. */
	gatewayWeight(rolloutId: string): number {
		return this.get(rolloutId)?.gatewayWeightPercent ?? 0;
	}

	private promote(rolloutId: string): RolloutState {
		const prev = this.require(rolloutId);
		const promoted = this.transition(ROLLOUT_EVENTS.Promoted, {
			rolloutId,
			flag: prev.policy.flag,
			percent: 100,
		});
		this.applyFlagPercent(prev.policy.flag, 100);
		return promoted;
	}

	private enterStage(rolloutId: string, stageIndex: number): RolloutState {
		const prev = this.require(rolloutId);
		const stage = must(
			prev.policy.stages[stageIndex],
			"prev.policy.stages[stageIndex]",
		);
		const percent = clamp(stage.percent);
		const grouped = isGrouped(stage);
		const state = this.transition(
			grouped ? ROLLOUT_EVENTS.StageStarted : ROLLOUT_EVENTS.Stepped,
			{
				rolloutId,
				flag: prev.policy.flag,
				stageIndex,
				percent,
				gatewayWeightPercent:
					prev.policy.traffic === "gateway-weighted"
						? percent
						: prev.gatewayWeightPercent,
				...(grouped
					? {
							groups: Object.freeze((stage.groups ?? []).map((g) => g.name)),
						}
					: undefined),
			},
		);
		this.applyFlagPercent(prev.policy.flag, percent);
		return state;
	}

	private applyFlagPercent(flag: string, percent: number): void {
		const existing = this.store.get(flag);
		// Never clear an active kill-switch on ramp start/step — treatment must stay dark.
		const killSwitch = existing?.killSwitch === true;
		this.store.define({
			key: flag,
			// Kill-switch forces zero percent; otherwise apply the stage percent.
			percentage: killSwitch ? 0 : percent,
			enabled: true,
			state: "ENABLED",
			killSwitch,
			defaultValue: existing?.defaultValue ?? false,
			variants: existing?.variants,
			defaultVariant: existing?.defaultVariant,
			...(existing?.migrationId !== undefined
				? { migrationId: existing.migrationId }
				: undefined),
			...(existing?.metadata !== undefined
				? { metadata: existing.metadata }
				: undefined),
			...(existing?.targeting !== undefined
				? { targeting: existing.targeting }
				: undefined),
		});
	}

	private require(id: string): RolloutState {
		const s = this.rollouts.get(id);
		if (!s) {
			throw Object.assign(new Error(`rollout not found: ${id}`), {
				code: "rollout-missing",
			});
		}
		return s;
	}

	/** Emit one journal event and fold it into state via the pure reducer. */
	private transition<T>(type: RolloutEvent["type"], data: T): RolloutState {
		this.seq += 1;
		const bag = asJsonObject(data);
		const event: RolloutEvent = Object.freeze({
			id: `evt-${type}-${this.seq}`,
			type,
			schemaVersion: ROLLOUT_EVENT_SCHEMA,
			seq: this.seq,
			time: this.now(),
			data: bag,
		});
		this.events.push(event);
		const rolloutId = String(bag.rolloutId);
		const next = applyRolloutEvent(this.rollouts.get(rolloutId), event);
		this.rollouts.set(rolloutId, next);
		return next;
	}
}

function freezeStage(s: RolloutStage): RolloutStage {
	return Object.freeze({
		...s,
		...(s.groups !== undefined
			? {
					groups: Object.freeze(
						s.groups.map((g) =>
							Object.freeze({
								...g,
								targets: Object.freeze([...g.targets]),
							}),
						),
					),
				}
			: undefined),
	});
}

function freezePolicy(p: RolloutPolicy): RolloutPolicy {
	return Object.freeze({
		name: p.name,
		flag: p.flag,
		stages: Object.freeze(p.stages.map((s) => freezeStage(s))),
		traffic: p.traffic,
		autoRollback: p.autoRollback === true,
		...(p.gatewayWeightPercent !== undefined
			? { gatewayWeightPercent: p.gatewayWeightPercent }
			: undefined),
	});
}

function clamp(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(100, Math.floor(n)));
}

function normalizeConcurrency(n: number | undefined): number {
	if (n === undefined || !Number.isFinite(n)) return Number.POSITIVE_INFINITY;
	return Math.max(1, Math.floor(n));
}

export function contentHashRollout(policy: RolloutPolicy): `sha256:${string}` {
	return `sha256:${createHash("sha256")
		.update(JSON.stringify(policy))
		.digest("hex")}`;
}
