/* oxlint-disable anti-slop/no-unknown-parameters */
import { createHash } from "node:crypto";
import * as z from "zod";

export const START_FENCE_EXIT = {
	authorized: 0,
	rejected: 41,
	conflict: 42,
	unavailableFailClosed: 43,
} as const;

export function runnerSlotName(slotId: string): string {
	return `hobo-${slotId}`;
}

export function hashBindingSecret(secret: string): string {
	return createHash("sha256").update(secret, "utf8").digest("hex");
}

const githubJobKeySchema = z.strictObject({
	kind: z.literal("github-job"),
	accountId: z.string().min(1),
	engineId: z.string().min(1),
	installationId: z.string().min(1),
	repositoryId: z.string().min(1),
	runId: z.string().min(1),
	jobId: z.string().min(1),
	runAttempt: z.number().int().min(1),
});

export const startFenceRequestSchema = z.strictObject({
	slotId: z.string().min(1),
	claimId: z.string().min(1),
	bindingSecret: z.string().min(32).max(1024),
	accountId: z.string().min(1),
	runnerName: z.string().min(1),
	profileId: z.string().min(1),
	executionKey: z.strictObject({
		githubJob: githubJobKeySchema,
	}),
});

export type StartFenceRequest = z.infer<typeof startFenceRequestSchema>;

export function parseStartFenceRequest(input: unknown) {
	return startFenceRequestSchema.safeParse(input);
}

export type VerifiedGithubAssignment = {
	runnerName: string;
	accountId: string;
	executionKey: { githubJob: z.infer<typeof githubJobKeySchema> };
};

export type GithubAssignmentLookup = {
	lookupAssignment(
		runnerName: string,
	): Promise<VerifiedGithubAssignment | undefined>;
};

export type StartFenceBindRequest = {
	slotId: string;
	claimId: string;
	bindingSecret: string;
	accountId: string;
	runnerName: string;
	profileId: string;
	executionKey: VerifiedGithubAssignment["executionKey"];
};

export type StartFenceAuthorization =
	| { ok: true; bindRequest: StartFenceBindRequest }
	| { ok: false; reason: string };

export async function authorizeStartFence(
	input: unknown,
	lookup: GithubAssignmentLookup,
): Promise<StartFenceAuthorization> {
	const parsed = parseStartFenceRequest(input);
	if (!parsed.success)
		return { ok: false, reason: "malformed start-fence request" };
	const body = parsed.data;
	const verified = await lookup.lookupAssignment(body.runnerName);
	if (verified === undefined)
		return { ok: false, reason: "github reports no assignment for runner" };
	if (verified.runnerName !== body.runnerName)
		return { ok: false, reason: "runner name mismatch" };
	if (verified.accountId !== body.accountId)
		return { ok: false, reason: "assignment account mismatch" };
	const claimed = body.executionKey.githubJob;
	const actual = verified.executionKey.githubJob;
	if (
		claimed.accountId !== actual.accountId ||
		claimed.engineId !== actual.engineId ||
		claimed.installationId !== actual.installationId ||
		claimed.repositoryId !== actual.repositoryId ||
		claimed.runId !== actual.runId ||
		claimed.jobId !== actual.jobId ||
		claimed.runAttempt !== actual.runAttempt
	)
		return { ok: false, reason: "assignment job identity mismatch" };
	return {
		ok: true,
		bindRequest: {
			slotId: body.slotId,
			claimId: body.claimId,
			bindingSecret: body.bindingSecret,
			accountId: verified.accountId,
			runnerName: verified.runnerName,
			profileId: body.profileId,
			executionKey: verified.executionKey,
		},
	};
}
