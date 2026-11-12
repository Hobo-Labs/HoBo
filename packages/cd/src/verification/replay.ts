// Replay (I8): recompute a recorded verdict from the recorded spec, evidence
// and finished_at, with no source, probe, suite or clock involved. Live and
// replay share evaluateVerification, so any mismatch means the journal or the
// verdict function changed — never that the world did.
import { equals } from "@bufbuild/protobuf";
import type { DurableEventStore, EventEnvelope } from "@hobo/core";
import { CheckOutcomeRecordSchema, VerificationVerdict } from "../_generated/cd_pb.js";
import { CD_STREAMS } from "../events.js";
import type { VerificationId } from "../ports.js";
import { evaluateVerification } from "./evaluate.js";
import { foldVerification } from "./journal.js";

export type VerificationReplay = Readonly<{
	verificationId: string;
	recorded: VerificationVerdict;
	replayed: VerificationVerdict;
	matches: boolean;
	/** Check names whose recomputed outcome differs from the recorded one. */
	mismatches: readonly string[];
}>;

/** Replay one cd-verification stream; undefined while it has no Completed event. */
export function replayVerification(events: Iterable<EventEnvelope>): VerificationReplay | undefined {
	const state = foldVerification(events);
	const recorded = state?.result;
	if (!state || !recorded) return undefined;
	if (!state.spec) {
		// A refused spec always completes FAIL with no checks.
		const matches = recorded.verdict === VerificationVerdict.FAIL && recorded.checks.length === 0;
		return { verificationId: state.id, recorded: recorded.verdict, replayed: VerificationVerdict.FAIL, matches, mismatches: matches ? [] : ["spec"] };
	}
	const evaluation = evaluateVerification({
		spec: state.spec,
		cohortAware: state.cohortAware,
		evidence: state.evidence,
		startedAtMs: state.startedAtMs,
		atMs: Date.parse(recorded.finishedAt),
	});
	const mismatches: string[] = [];
	if (!evaluation.complete) mismatches.push("incomplete");
	const replayedByName = new Map(evaluation.checks.map((check) => [check.check, check]));
	for (const check of recorded.checks) {
		const replayed = replayedByName.get(check.check);
		if (!replayed || !equals(CheckOutcomeRecordSchema, replayed, check)) mismatches.push(check.check);
		replayedByName.delete(check.check);
	}
	mismatches.push(...replayedByName.keys());
	const replayedVerdict = evaluation.complete ? evaluation.verdict : VerificationVerdict.UNSPECIFIED;
	if (replayedVerdict !== recorded.verdict) mismatches.push("verdict");
	return { verificationId: state.id, recorded: recorded.verdict, replayed: replayedVerdict, matches: mismatches.length === 0, mismatches };
}

/** Replay a verification straight from the store. */
export async function replayVerificationFromStore(store: DurableEventStore, id: VerificationId): Promise<VerificationReplay | undefined> {
	const events: EventEnvelope[] = [];
	for await (const event of store.read(CD_STREAMS.verification(id))) events.push(event);
	return replayVerification(events);
}
