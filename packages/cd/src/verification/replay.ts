import { equals } from "@bufbuild/protobuf";
import type { DurableEventStore, EventEnvelope } from "@hobo/core";
import {
	CheckOutcomeRecordSchema,
	VerificationVerdict,
} from "../_generated/cd_pb.js";
import { CD_STREAMS } from "../events.js";
import type { VerificationId } from "../ports.js";
import { evaluateVerification } from "./evaluate.js";
import { evidenceDigest } from "./evidence.js";
import { foldVerification } from "./journal.js";

export type VerificationReplay = Readonly<{
	verificationId: string;
	recorded: VerificationVerdict;
	replayed: VerificationVerdict;
	matches: boolean;
	mismatches: readonly string[];
}>;

export function replayVerification(
	events: Iterable<EventEnvelope>,
): VerificationReplay | undefined {
	const state = foldVerification(events);
	const recorded = state?.result;
	if (!state || !recorded) return undefined;
	if (!state.spec) {
		const matches =
			recorded.verdict === VerificationVerdict.FAIL &&
			recorded.checks.length === 0;
		return {
			verificationId: state.id,
			recorded: recorded.verdict,
			replayed: VerificationVerdict.FAIL,
			matches,
			mismatches: matches ? [] : ["spec"],
		};
	}
	const evaluation = evaluateVerification({
		spec: state.spec,
		cohortAware: state.cohortAware,
		evidence: state.evidence,
		startedAtMs: state.startedAtMs,
		atMs: Date.parse(recorded.finishedAt),
	});
	const mismatches: string[] = [];
	if (
		recorded.evidenceDigest &&
		recorded.evidenceDigest !==
			evidenceDigest({
				spec: state.spec,
				cohortAware: state.cohortAware,
				evidence: state.evidence,
				startedAtMs: state.startedAtMs,
				atMs: Date.parse(recorded.finishedAt),
			})
	)
		mismatches.push("evidence-digest");
	if (!evaluation.complete) mismatches.push("incomplete");
	const replayedByName = new Map(
		evaluation.checks.map((check) => [check.check, check]),
	);
	for (const check of recorded.checks) {
		const replayed = replayedByName.get(check.check);
		if (!replayed || !equals(CheckOutcomeRecordSchema, replayed, check))
			mismatches.push(check.check);
		replayedByName.delete(check.check);
	}
	mismatches.push(...replayedByName.keys());
	const replayedVerdict = evaluation.complete
		? evaluation.verdict
		: VerificationVerdict.UNSPECIFIED;
	if (replayedVerdict !== recorded.verdict) mismatches.push("verdict");
	return {
		verificationId: state.id,
		recorded: recorded.verdict,
		replayed: replayedVerdict,
		matches: mismatches.length === 0,
		mismatches,
	};
}

export async function replayVerificationFromStore(
	store: DurableEventStore,
	id: VerificationId,
): Promise<VerificationReplay | undefined> {
	const events: EventEnvelope[] = [];
	for await (const event of store.read(CD_STREAMS.verification(id)))
		events.push(event);
	return replayVerification(events);
}
