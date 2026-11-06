import { z } from "zod";
import { WorkerIdentitySchema } from "./vm-delivery.mts";

const Sha = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const Source = z.string().regex(/^[a-f0-9]{40}$/u);
const Positive = z.number().int().positive();
export const ControllerPublicArtifactSchema = z.strictObject({
	version: z.literal(1),
	kind: z.literal("hobo-controller-ready"),
	appId: z.literal(5636332),
	repositoryId: z.literal(1274791462),
	runId: Positive,
	runAttempt: Positive,
	sourceSha: Source,
	publicKey: z.string().min(100).max(8192),
	localPublicKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const WorkerPublicArtifactSchema = WorkerIdentitySchema.extend({
	version: z.literal(1),
	kind: z.literal("hobo-worker-ready"),
	publicKey: z.string().min(100).max(8192),
	preflight: z.strictObject({
		ok: z.literal(true),
		imageId: Sha,
		architecture: z.literal("x64"),
	}),
});
export const WorkerCompletionArtifactSchema = WorkerIdentitySchema.extend({
	version: z.literal(1),
	kind: z.literal("hobo-worker-complete"),
	exitCode: z.number().int().min(0).max(255),
	oomKilled: z.boolean(),
	runnerExited: z.boolean(),
});
export const PublicArtifactSchema = z.discriminatedUnion("kind", [
	ControllerPublicArtifactSchema,
	WorkerPublicArtifactSchema,
	WorkerCompletionArtifactSchema,
]);
export type PublicArtifact = z.infer<typeof PublicArtifactSchema>;
export const NativeArtifactSchema = z.object({
	id: Positive,
	name: z.string().min(1),
	expired: z.literal(false),
	digest: Sha,
	size_in_bytes: z.number().int().nonnegative().max(1048576),
	workflow_run: z.object({ id: Positive, head_sha: Source }),
});
export type NativeArtifact = z.infer<typeof NativeArtifactSchema>;
export type VerifiedPublicArtifact = {
	artifact: NativeArtifact;
	value: PublicArtifact;
};
export const MailboxDocumentSchema = z.record(z.string(), z.json());
export type MailboxDocument = z.infer<typeof MailboxDocumentSchema>;
export const NativeRunSchema = z.object({
	id: Positive,
	run_attempt: Positive,
	head_sha: Source,
	workflow_id: Positive,
	head_branch: z.string(),
	path: z.string(),
	display_title: z.string(),
	event: z.string(),
	repository: z.object({ id: Positive }),
});
export const NativeJobsSchema = z.object({
	jobs: z.array(
		z.object({
			name: z.string(),
			status: z.string(),
			conclusion: z.string().nullable(),
			steps: z
				.array(
					z.object({ name: z.string(), conclusion: z.string().nullable() }),
				)
				.default([]),
		}),
	),
});
export const ContentsFileSchema = z.object({
	encoding: z.literal("base64"),
	content: z.string(),
	size: z.number().int().nonnegative().max(900000),
});
