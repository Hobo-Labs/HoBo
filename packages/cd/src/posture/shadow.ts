import { create } from "@bufbuild/protobuf";
import type { PolicyPack } from "@hobo/contracts";
import {
	type ShadowDecisionRecord,
	ShadowDecisionRecordSchema,
} from "../_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS } from "../events.js";
import type {
	CampPolicy,
	CdBase,
	Digest,
	ShadowRecorder,
	TelemetrySink,
} from "../ports.js";
import { appendOnce, asDigest, body, emit } from "./journal.js";
import {
	POSTURE_METRIC,
	POSTURE_REASON,
	PostureJournalError,
} from "./reasons.js";

export type ShadowRecorderDeps = CdBase & {
	readonly campPolicy: CampPolicy;
	readonly resolvePack: (railDigest: Digest) => Promise<PolicyPack>;
	readonly telemetry?: TelemetrySink;
};

function invalid(message: string): PostureJournalError {
	return new PostureJournalError(
		POSTURE_REASON.shadowInvalid,
		message,
		"The gate must record a shadow decision with the Camp id, Delta id, candidate Rail digest and both effects.",
	);
}

export function createShadowRecorder(d: ShadowRecorderDeps): ShadowRecorder {
	return {
		async candidate(campId) {
			const binding = await d.campPolicy.binding(campId);
			const railDigest = asDigest(binding?.candidateRailDigest ?? "");
			if (!railDigest) return undefined;
			return { railDigest, policyPack: await d.resolvePack(railDigest) };
		},

		async record(decision, ctx) {
			if (decision.campId === "") throw invalid("decision names no Camp");
			if (decision.deltaId === "") throw invalid("decision names no Delta");
			const candidate = asDigest(decision.candidateRailDigest);
			if (!candidate)
				throw invalid(
					`candidate Rail digest ${JSON.stringify(decision.candidateRailDigest)} is not sha256`,
				);
			if (decision.enforcedEffect === "" || decision.candidateEffect === "")
				throw invalid("both effects are required");
			const diverged = decision.enforcedEffect !== decision.candidateEffect;
			const record: ShadowDecisionRecord = create(ShadowDecisionRecordSchema, {
				...decision,
				diverged,
			});
			const appended = await appendOnce({
				store: d.store,
				tenant: d.tenant,
				actor: ctx.principal,
				streamId: CD_STREAMS.compliance(decision.campId),
				event: {
					type: CD_EVENTS.PolicyShadowDecided,
					data: body(ShadowDecisionRecordSchema, record),
				},
				idempotencyKey: `shadow:${decision.deltaId}:${candidate}`,
			});
			if (!appended)
				throw new PostureJournalError(
					POSTURE_REASON.journalConflict,
					`could not append policy.ShadowDecided to ${CD_STREAMS.compliance(decision.campId)}`,
					"Retry the gate evaluation; recording is idempotent per Delta and candidate.",
				);
			if (!appended.fresh) return;
			const atMs = ctx.now();
			const attributes = {
				tenant: d.tenant,
				camp: decision.campId,
				candidate,
				enforced_effect: decision.enforcedEffect,
				candidate_effect: decision.candidateEffect,
			};
			emit(d.telemetry, [
				{
					name: POSTURE_METRIC.shadowDecisions,
					kind: "counter",
					value: 1,
					unit: "{decision}",
					atMs,
					attributes,
				},
				...(diverged
					? [
							{
								name: POSTURE_METRIC.shadowDivergence,
								kind: "counter" as const,
								value: 1,
								unit: "{divergence}",
								atMs,
								attributes,
							},
						]
					: []),
			]);
		},
	};
}
