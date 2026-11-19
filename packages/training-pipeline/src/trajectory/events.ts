import type { EventEnvelope, PrincipalRef } from "@hobo/core";
import { createEventEnvelope, diagnosticJson } from "@hobo/core";
import type { CapturedTrajectory } from "./capture.js";
import { TrajectoryCaptureParseError } from "./trace-context.js";

export const TRAINING_TRAJECTORY_CAPTURED = "training.TrajectoryCaptured";

export interface TrajectoryCapturedEventOptions {
	readonly eventId: string;
	readonly seq: number;
	readonly ts: string;
	readonly actor: PrincipalRef;
	readonly tenant?: string;
	readonly streamId?: string;
	readonly correlationId?: string;
	readonly causationId?: string;
}

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
		correlationId: options.correlationId,
		causationId: options.causationId,
	};
	return createEventEnvelope(envelope);
}
