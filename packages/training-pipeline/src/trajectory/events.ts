import type { EventEnvelope, PrincipalRef } from "@hobo/core";
import { createEventEnvelope, diagnosticJson } from "@hobo/core";
import type { CapturedTrajectory } from "./capture.js";
import { TrajectoryCaptureParseError } from "./trace-context.js";

// A completed capture rides the existing training.* event family
// (docs/design/event-families.md) — the same registry promotionEventNames
// draws training.Promoted / impl.Promoted / eval.GateFailed from — so
// capture → grade → aggregate → promotion gate is one event-sourced loop.

// public-contract: trajectory-capture past-tense fact riding the training.* family; stored trajectory rides the event log.
export const TRAINING_TRAJECTORY_CAPTURED = "training.TrajectoryCaptured";

export interface TrajectoryCapturedEventOptions {
	readonly eventId: string;
	readonly seq: number;
	/** ISO-8601 event timestamp. */
	readonly ts: string;
	readonly actor: PrincipalRef;
	/** Defaults to the trajectory's run tenant. */
	readonly tenant?: string;
	/** Defaults to `training:<runId>`. */
	readonly streamId?: string;
	readonly correlationId?: string;
	readonly causationId?: string;
}

/**
 * Wraps a captured trajectory in the platform EventEnvelope as a
 * `training.TrajectoryCaptured` fact: the proto-JSON wire form of the
 * trajectory (plus its provenance hash) is the event data, and the W3C
 * traceparent rides `meta` so the event joins the same trace as the run.
 */
export function trajectoryCapturedEvent(
	captured: CapturedTrajectory,
	options: TrajectoryCapturedEventOptions,
): EventEnvelope {
	const run = captured.trajectory.run;
	if (!run) {
		throw new TrajectoryCaptureParseError(
			"trajectory.run",
			"present",
			diagnosticJson(captured.trajectory),
		);
	}
	const envelope: Parameters<typeof createEventEnvelope>[0] = {
		id: options.eventId,
		type: TRAINING_TRAJECTORY_CAPTURED,
		streamId: options.streamId ?? `training:${run.id}`,
		seq: options.seq,
		ts: options.ts,
		actor: options.actor,
		tenant: options.tenant ?? run.tenantId,
		data: {
			trajectoryId: captured.trajectory.id,
			trajectoryHash: captured.hash,
			trajectory: captured.trajectoryJson,
		},
		meta: { traceparent: captured.trajectory.traceparent },
		...(options.correlationId === undefined
			? {}
			: { correlationId: options.correlationId }),
		...(options.causationId === undefined
			? {}
			: { causationId: options.causationId }),
	};
	return createEventEnvelope(envelope);
}
