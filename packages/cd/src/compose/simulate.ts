// The labelled `--simulate` fixture path (WP18, plan 0024, C2).
//
// `--simulate` is the only way to reach a fixture. The simulated realizer
// touches no target: it reports the desired Set as converged and labels every
// observation with reason code `simulated`, so a simulated convergence can
// never be mistaken for a real one in status, logs, CDEvents or DORA.
import { create } from "@bufbuild/protobuf";
import {
	ReasonRecordSchema,
	type ReconcileObservationRecord,
	ReconcileObservationRecordSchema,
	ReconcileStatus,
} from "../_generated/cd_pb.js";
import type { RealizeInput, Realizer } from "../ports.js";

// public-contract: the label every simulated observation carries.
export const SIMULATED_REASON = Object.freeze({
	code: "simulated",
	message:
		"--simulate: the simulated realizer touched no target; this convergence is a fixture",
	remediation:
		"run without --simulate against a configured conductor realizer, agent or publisher",
} as const);

function observation(
	input: RealizeInput,
	atMs: number,
): ReconcileObservationRecord {
	return create(ReconcileObservationRecordSchema, {
		campId: input.campId,
		setId: input.desired.setId,
		reconcilerId: input.reconcilerId,
		fenceToken: input.fence.toString(),
		status: ReconcileStatus.CONVERGED,
		reasons: [
			create(ReasonRecordSchema, {
				...SIMULATED_REASON,
				subject: input.campId,
			}),
		],
		observedAt: new Date(atMs).toISOString(),
	});
}

/** A realizer that only labels. Available to the composition root under --simulate. */
export function createSimulatedRealizer(): Realizer {
	return Object.freeze({
		async converge(input: RealizeInput, ctx: { now: () => number }) {
			return observation(input, ctx.now());
		},
		async observe(input: RealizeInput, ctx: { now: () => number }) {
			return observation(input, ctx.now());
		},
	});
}

/** True when an observation came from the simulated realizer. */
export function isSimulatedObservation(o: ReconcileObservationRecord): boolean {
	return o.reasons.some((r) => r.code === SIMULATED_REASON.code);
}
