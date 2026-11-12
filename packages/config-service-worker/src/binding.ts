/**
 * The deploy-time binding HoBo bakes into the Worker (`HOBO_CONFIG_BINDING`):
 * who may read and write, the store's id, and the hash of the single-use
 * bootstrap credential. Built from the protobuf record, parsed by the same
 * parser the Worker runs, so what HoBo uploads is what the Worker accepts.
 */
import { randomBytes } from "node:crypto";
import { create, toJsonString } from "@bufbuild/protobuf";
import {
	ConfigServiceOwnerAccessSchema,
	ConfigServiceWorkerBindingSchema,
} from "./_generated/config_service_worker_pb.js";
import { sha256Hex } from "./worker/bytes.js";
import {
	type OwnerAccess,
	parseOwnerAccess,
	parseWorkerBinding,
	type WorkerBinding,
} from "./worker/records.js";

export type { OwnerAccess, WorkerBinding };

export class ConfigServiceBindingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigServiceBindingError";
	}
}

/** A fresh store id: random, non-secret, lower-case. */
export function newStoreId(): string {
	return randomBytes(12).toString("hex");
}

/** The audience a GitHub Actions job asks for to reach this store. */
export function githubAudienceFor(storeId: string): string {
	return `urn:hobo:config-service:${storeId}`;
}

export type BootstrapCredential = Readonly<{
	/** The bearer value: sent once, then gone. */
	credential: string;
	sha256: string;
}>;

/** 32 random bytes, base64url, and the hash the Worker keeps. */
export async function newBootstrapCredential(): Promise<BootstrapCredential> {
	const credential = randomBytes(32).toString("base64url");
	return Object.freeze({ credential, sha256: await sha256Hex(credential) });
}

export type WorkerBindingInput = Readonly<{
	storeId: string;
	vercelTeamSlug: string;
	vercelTeamId: string;
	vercelProjectName: string;
	vercelProjectId: string;
	vercelEnvironment?: string;
	repository: string;
	ref?: string;
	repositoryId?: string;
	bootstrapSha256: string;
	bootstrapExpiresAt: Date;
}>;

/** The binding's text for the plain-text variable; refuses an invalid one. */
export function formatWorkerBinding(input: WorkerBindingInput): string {
	const environment = input.vercelEnvironment ?? "production";
	const text = toJsonString(
		ConfigServiceWorkerBindingSchema,
		create(ConfigServiceWorkerBindingSchema, {
			storeId: input.storeId,
			relay: {
				issuer: `https://oidc.vercel.com/${input.vercelTeamSlug}`,
				audience: `https://vercel.com/${input.vercelTeamSlug}`,
				subject: `owner:${input.vercelTeamSlug}:project:${input.vercelProjectName}:environment:${environment}`,
				ownerId: input.vercelTeamId,
				projectId: input.vercelProjectId,
				environment,
			},
			deploy: {
				issuer: "https://token.actions.githubusercontent.com",
				audience: githubAudienceFor(input.storeId),
				repository: input.repository,
				ref: input.ref ?? "refs/heads/main",
				repositoryId: input.repositoryId ?? "",
			},
			bootstrapSha256: input.bootstrapSha256,
			bootstrapExpiresAt: input.bootstrapExpiresAt.toISOString(),
		}),
	);
	if (parseWorkerBinding(text) === undefined)
		throw new ConfigServiceBindingError(
			"the config-service Worker binding does not meet its constraints (team slug, project, repository, ref)",
		);
	return text;
}

/** Parse the binding text the Worker would read. */
export function parseConfigServiceWorkerBinding(text: string): WorkerBinding {
	const binding = parseWorkerBinding(text);
	if (binding === undefined)
		throw new ConfigServiceBindingError(
			"not a config-service Worker binding that meets its constraints",
		);
	return binding;
}

/** The owner's `HOBO_CONFIG_OWNER_ACCESS` text, from their Access application. */
export function formatOwnerAccess(issuer: string, audience: string): string {
	const text = toJsonString(
		ConfigServiceOwnerAccessSchema,
		create(ConfigServiceOwnerAccessSchema, { issuer, audience }),
	);
	if (parseOwnerAccess(text) === undefined)
		throw new ConfigServiceBindingError(
			"an Access issuer is https://<team>.cloudflareaccess.com and an AUD tag is 16 to 128 letters and digits",
		);
	return text;
}
