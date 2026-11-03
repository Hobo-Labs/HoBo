import { createHash } from "node:crypto";
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- HTTP boundary; parseStartBindingInput refines immediately */
import { toJsonString } from "@bufbuild/protobuf";
import {
	ExecutionKeySchema,
	parseExecutionKey,
	parseStartBindingInput,
} from "@hobo/ci/fleet-v2";

/** Deterministic runner slot name per design §9.2. */
export function runnerSlotName(slotId: string): string {
	return `hobo-${slotId}`;
}

/** Hash binding material for controller-side storage (never log the secret). */
export function hashBindingSecret(secret: string): string {
	return createHash("sha256").update(secret).digest("hex");
}

export interface StartFenceAssignment {
	verified: true;
	accountId: string;
	runnerName: string;
	profileId: string;
	repositoryId: string;
	runId: string;
	jobId: string;
	runAttempt: number;
}

/** Parse hook payload after GitHub assignment verification (central credentials). */
export function parseStartFenceRequest(body: unknown) {
	const record = body as Record<string, unknown>;
	const key = parseExecutionKey(JSON.stringify(record.executionKey));
	return parseStartBindingInput({
		slotId: String(record.slotId),
		claimId: String(record.claimId),
		key: JSON.parse(toJsonString(ExecutionKeySchema, key)),
		bindingSecret: String(record.bindingSecret),
		assignment: {
			verified: true,
			accountId: String(record.accountId),
			runnerName: String(record.runnerName),
			profileId: String(record.profileId),
		},
	});
}

/** Nonzero hook exit codes for the official pre-job hook contract. */
export const START_FENCE_EXIT = {
	authorized: 0,
	rejected: 42,
	uncertain: 43,
	timeout: 44,
} as const;
