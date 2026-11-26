/**
 * Trail run aggregate — event-sourced progressive continuous migration state.
 * Idle → Planned → DualActive → Ramping → Validated → Cutover | Compensated | Aborted | Failed
 */
import { randomUUID } from "node:crypto";

import type { TrailDefinition } from "./definition.js";
import { createTrailEvent, TRAIL_EVENTS, type TrailEvent } from "./events.js";
import type { JsonObject } from "./json.js";

// public-contract: trail run state machine.
export const TRAIL_RUN_STATES = Object.freeze([
	"idle",
	"planned",
	"dual-active",
	"ramping",
	"validated",
	"cutover",
	"compensated",
	"aborted",
	"failed",
] as const);

export type TrailRunState = (typeof TRAIL_RUN_STATES)[number];

export type TrailRunRecord = Readonly<{
	runId: string;
	trailId: string;
	trailVersion: string;
	tenant: string;
	target: string;
	state: TrailRunState;
	/** 0–100 progressive ramp across dual steps. */
	percent: number;
	currentStepId?: string;
	completedSteps: readonly string[];
	identityLinked: boolean;
	junctionOk: boolean;
	dualOk: boolean;
	contentHash: string;
	startedAt: string;
	updatedAt: string;
	reason?: string;
}>;

export class TrailRunService {
	readonly events: TrailEvent[] = [];
	private seq = 0;
	private record: TrailRunRecord | null = null;
	private readonly now: () => string;

	constructor(options?: { readonly now?: () => string }) {
		this.now = options?.now ?? (() => new Date().toISOString());
	}

	snapshot(): TrailRunRecord | null {
		return this.record;
	}

	start(input: {
		readonly trail: TrailDefinition;
		readonly tenant: string;
		readonly target: string;
		readonly identityLinked?: boolean;
	}): TrailRunRecord {
		if (this.record && !isTerminal(this.record.state)) {
			throw Object.assign(new Error("trail run already active"), {
				code: "trail-run-active",
			});
		}
		const runId = `trailrun_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
		const t = this.now();
		this.record = Object.freeze({
			runId,
			trailId: input.trail.id,
			trailVersion: input.trail.version,
			tenant: input.tenant,
			target: input.target,
			state: "planned",
			percent: 0,
			// SAFETY: the aggregate owns and mutates this private string list.
			completedSteps: Object.freeze([] as string[]),
			identityLinked: input.identityLinked === true,
			junctionOk: true,
			dualOk: true,
			contentHash: input.trail.contentHash,
			startedAt: t,
			updatedAt: t,
		});
		this.emit(TRAIL_EVENTS.Started, {
			runId,
			trailId: input.trail.id,
			version: input.trail.version,
			target: input.target,
			identityLinked: input.identityLinked === true,
			bindleConfigRequired: false,
		});
		this.emit(TRAIL_EVENTS.Planned, {
			runId,
			stepCount: input.trail.steps.length,
			contentHash: input.trail.contentHash,
		});
		return this.record;
	}

	enterDual(stepId: string): TrailRunRecord {
		return this.transition("dual-active", {
			currentStepId: stepId,
			percent: Math.max(this.record?.percent ?? 0, 0),
		});
	}

	ramp(percent: number, stepId?: string): TrailRunRecord {
		const p = Math.max(0, Math.min(100, Math.floor(percent)));
		return this.transition("ramping", {
			percent: p,
			...(stepId !== undefined ? { currentStepId: stepId } : undefined),
		});
	}

	completeStep(stepId: string): TrailRunRecord {
		const prev = this.require();
		const completed = Object.freeze([
			...prev.completedSteps.filter((s) => s !== stepId),
			stepId,
		]);
		return this.transition(
			prev.state === "planned" ? "dual-active" : prev.state,
			{
				completedSteps: completed,
				currentStepId: stepId,
			},
		);
	}

	markValidated(): TrailRunRecord {
		return this.transition("validated", { dualOk: true });
	}

	cutover(): TrailRunRecord {
		const rec = this.transition("cutover", { percent: 100 });
		this.emit(TRAIL_EVENTS.Cutover, {
			runId: rec.runId,
			trailId: rec.trailId,
			completedSteps: rec.completedSteps,
		});
		return rec;
	}

	abort(reason: string): TrailRunRecord {
		const rec = this.transition("aborted", { reason, dualOk: false });
		this.emit(TRAIL_EVENTS.Aborted, {
			runId: rec.runId,
			reason,
		});
		return rec;
	}

	compensate(reason: string): TrailRunRecord {
		const rec = this.transition("compensated", {
			reason,
			percent: 0,
			dualOk: false,
		});
		this.emit(TRAIL_EVENTS.Compensated, {
			runId: rec.runId,
			reason,
			rollbackPosture: "compensate-to-source",
		});
		return rec;
	}

	fail(reason: string): TrailRunRecord {
		const rec = this.transition("failed", { reason, dualOk: false });
		this.emit(TRAIL_EVENTS.Failed, { runId: rec.runId, reason });
		return rec;
	}

	setDualHealth(ok: boolean): TrailRunRecord {
		const prev = this.require();
		if (!ok) {
			// Fail-closed from any non-terminal path, including validated/cutover
			// if dual re-check fails late (unsafe cutover must not stick).
			if (!isTerminal(prev.state) || prev.state === "cutover") {
				return this.compensate("dual-oracle-failed");
			}
			return this.transition(prev.state, { dualOk: false });
		}
		return this.transition(prev.state, { dualOk: true });
	}

	setJunctionHealth(ok: boolean): TrailRunRecord {
		const prev = this.require();
		if (!ok) {
			// Same fail-closed rule as dual: compensate even after cutover.
			if (!isTerminal(prev.state) || prev.state === "cutover") {
				return this.compensate("junction-unhealthy");
			}
			return this.transition(prev.state, { junctionOk: false });
		}
		return this.transition(prev.state, { junctionOk: true });
	}

	private transition(
		state: TrailRunState,
		patch: Partial<TrailRunRecord>,
	): TrailRunRecord {
		const prev = this.require();
		// Allow compensating out of cutover (late dual/junction failure).
		if (
			isTerminal(prev.state) &&
			!(prev.state === "cutover" && state === "compensated")
		) {
			if (prev.state !== state) {
				throw Object.assign(
					new Error(`trail run already terminal: ${prev.state}`),
					{ code: "trail-run-terminal" },
				);
			}
		}
		const t = this.now();
		this.record = Object.freeze({
			...prev,
			...patch,
			state,
			updatedAt: t,
			completedSteps: Object.freeze([
				...(patch.completedSteps ?? prev.completedSteps),
			]),
		});
		if (state === "dual-active") {
			this.emit(TRAIL_EVENTS.DualActive, {
				runId: this.record.runId,
				stepId: this.record.currentStepId,
				percent: this.record.percent,
			});
		} else if (state === "ramping" || state === "planned") {
			this.emit(TRAIL_EVENTS.Progressed, {
				runId: this.record.runId,
				state,
				percent: this.record.percent,
				stepId: this.record.currentStepId,
			});
		} else if (state === "validated") {
			this.emit(TRAIL_EVENTS.Validated, {
				runId: this.record.runId,
				dualOk: true,
			});
		}
		return this.record;
	}

	private emit(type: TrailEvent["type"], data: JsonObject): void {
		const rec = this.require();
		this.seq += 1;
		this.events.push(
			createTrailEvent(type, {
				tenant: rec.tenant,
				trailRunId: rec.runId,
				seq: this.seq,
				time: this.now(),
				identityLinked: rec.identityLinked,
				data,
			}),
		);
	}

	private require(): TrailRunRecord {
		if (!this.record) {
			throw Object.assign(new Error("no active trail run"), {
				code: "trail-run-missing",
			});
		}
		return this.record;
	}
}

function isTerminal(state: TrailRunState): boolean {
	return (
		state === "cutover" ||
		state === "compensated" ||
		state === "aborted" ||
		state === "failed"
	);
}
