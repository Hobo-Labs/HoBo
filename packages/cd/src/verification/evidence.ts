import { createHash } from "node:crypto";
import { toJson } from "@bufbuild/protobuf";
import {
	type EvidenceObservationRecord,
	EvidenceObservationRecordSchema,
	type VerificationSpecRecord,
	VerificationSpecRecordSchema,
} from "../_generated/cd_pb.js";

export function evidenceDigest(
	input: Readonly<{
		spec: VerificationSpecRecord;
		cohortAware: boolean;
		evidence: readonly EvidenceObservationRecord[];
		startedAtMs: number;
		atMs: number;
	}>,
): string {
	const content = [
		toJson(VerificationSpecRecordSchema, input.spec),
		input.cohortAware,
		input.startedAtMs,
		input.atMs,
		input.evidence.map((item) => toJson(EvidenceObservationRecordSchema, item)),
	];
	return `sha256:${createHash("sha256").update(JSON.stringify(content)).digest("hex")}`;
}
