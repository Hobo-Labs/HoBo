import { readFileSync } from "node:fs";

import {
	createInfisicalClient,
	createInfisicalSecretsPort,
	infisicalSecretRef,
	type JwtSource,
	oidcAuth,
	type ParsedInfisicalBinding,
	parseInfisicalBinding,
	parseInfisicalIdentityId,
} from "@hobo/adapter-infisical";
import type { OpenedSecretStore } from "@hobo/hobo-ci";
import { getVercelOidcToken } from "@vercel/oidc";
import { z } from "zod";

/* oxlint-disable anti-slop/no-unknown-parameters -- SAFETY: cdStoreBindingErrorOf is the parse boundary for untyped compose failures from deps.open and openCdRuntime. */

export class CdStoreBindingError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "CdStoreBindingError";
		this.code = code;
	}
}

function isString(value: unknown): value is string {
	return value === String(value);
}

export function cdStoreBindingErrorOf(
	error: unknown,
): CdStoreBindingError | undefined {
	if (error instanceof CdStoreBindingError) return error;
	if (
		error instanceof Error &&
		"code" in error &&
		isString(error.code) &&
		error.code.startsWith("cd-")
	)
		return new CdStoreBindingError(error.code, error.message);
	return undefined;
}

export function isPermanentComposeError(error: unknown): boolean {
	return cdStoreBindingErrorOf(error) !== undefined;
}

export const vercelOidcJwtSource: JwtSource = () => getVercelOidcToken();

// public-contract: the committed store coordinates HoBo.CD on Vercel reads (ids only).
export const CD_STORE_BINDING_URL = new URL(
	"../deploy/secret-store.binding.json",
	import.meta.url,
);

const BindingRecord = z
	.object({
		kind: z.enum(["infisical-cloud-attach", "infisical-self-hosted"]),
		endpoint: z.string(),
		projectId: z.string(),
		environment: z.string(),
		secretPath: z.string(),
		relayIdentityId: z.string(),
	})
	.loose();

export type CdStoreCoordinates = Readonly<{
	binding: ParsedInfisicalBinding;
	identityId: string;
}>;

export function parseCdStoreCoordinates(text: string): CdStoreCoordinates {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		throw new CdStoreBindingError(
			"cd-store-binding-invalid",
			"deploy/secret-store.binding.json is not JSON.",
		);
	}
	const record = BindingRecord.safeParse(json);
	if (!record.success)
		throw new CdStoreBindingError(
			"cd-store-binding-invalid",
			"deploy/secret-store.binding.json is not an Infisical store binding.",
		);
	try {
		const binding = parseInfisicalBinding({
			siteUrl: record.data.endpoint,
			projectId: record.data.projectId,
			environment: record.data.environment,
			secretPath: record.data.secretPath,
		});
		const identityId = parseInfisicalIdentityId(record.data.relayIdentityId);
		oidcAuth({ identityId, jwt: vercelOidcJwtSource });
		return Object.freeze({ binding, identityId });
	} catch {
		throw new CdStoreBindingError(
			"cd-store-binding-invalid",
			"deploy/secret-store.binding.json names an invalid store or identity.",
		);
	}
}

export function readCdStoreCoordinates(
	url: URL = CD_STORE_BINDING_URL,
): CdStoreCoordinates {
	let text: string;
	try {
		text = readFileSync(url, "utf8");
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			isString(error.code) &&
			error.code === "ENOENT"
		)
			throw new CdStoreBindingError(
				"cd-store-binding-missing",
				"No store binding is committed for HoBo.CD (deploy/secret-store.binding.json). hobo cd up writes it once the CD workload identity exists.",
			);
		throw new CdStoreBindingError(
			"cd-store-binding-unreadable",
			"deploy/secret-store.binding.json exists but could not be read.",
		);
	}
	return parseCdStoreCoordinates(text);
}

type Env = Readonly<Record<string, string | undefined>>;

export function cdStoreCoordinatesFromEnv(
	env: Env,
): CdStoreCoordinates | undefined {
	const identityId = env.INFISICAL_IDENTITY_ID;
	const projectId = env.INFISICAL_PROJECT_ID;
	if (identityId === undefined || projectId === undefined) return undefined;
	return parseCdStoreCoordinates(
		JSON.stringify({
			kind: "infisical-cloud-attach",
			endpoint: env.INFISICAL_SITE_URL ?? "https://app.infisical.com",
			projectId,
			environment: env.INFISICAL_ENVIRONMENT ?? "prod",
			secretPath: env.INFISICAL_SECRET_PATH ?? "/hobo-cd",
			relayIdentityId: identityId,
		}),
	);
}

export function cdStoreCoordinates(
	env: Env,
	url: URL = CD_STORE_BINDING_URL,
): CdStoreCoordinates {
	try {
		return readCdStoreCoordinates(url);
	} catch (error) {
		if (
			!(error instanceof CdStoreBindingError) ||
			error.code !== "cd-store-binding-missing"
		)
			throw error;
		const configured = cdStoreCoordinatesFromEnv(env);
		if (configured === undefined) throw error;
		return configured;
	}
}

export function openCdStore(
	coordinates: CdStoreCoordinates,
	options: Readonly<{ jwt?: JwtSource; fetch?: typeof fetch }> = {},
): OpenedSecretStore {
	const auth = oidcAuth({
		identityId: coordinates.identityId,
		jwt: options.jwt ?? vercelOidcJwtSource,
	});
	const client = createInfisicalClient({
		binding: coordinates.binding,
		auth,
		...(options.fetch !== undefined ? { fetch: options.fetch } : undefined),
	});
	return Object.freeze({
		id: "infisical",
		port: createInfisicalSecretsPort({ client }),
		reference: (name: string) => infisicalSecretRef(coordinates.binding, name),
	});
}
