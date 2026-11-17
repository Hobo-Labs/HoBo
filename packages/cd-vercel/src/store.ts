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

// The owner's secret store, as HoBo.CD on Vercel opens it: the store's
// coordinates come from the committed `deploy/secret-store.binding.json`
// (ids only, the `SecretStoreBinding` record of `@hobo/secret-store-claim`),
// and the deployment signs in with its own Vercel OIDC token (Infisical OIDC
// Auth). No token is stored anywhere: not in Vercel's environment, not in a
// file. The folder is the one `hobo cd up` writes (`/hobo-cd`): the journal
// fleet's roster and connection strings.

/** Why the store could not be opened; names a cause, never a value. */
export class CdStoreBindingError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "CdStoreBindingError";
		this.code = code;
	}
}

/** The deployment's Vercel OIDC token; Vercel delivers it per request. */
export const vercelOidcJwtSource: JwtSource = () => getVercelOidcToken();

// public-contract: the committed store coordinates HoBo.CD on Vercel reads (ids only).
export const CD_STORE_BINDING_URL = new URL(
	"../deploy/secret-store.binding.json",
	import.meta.url,
);

// The fields of `SecretStoreBinding` CD reads. `relayIdentityId` is the
// record's name for the workload identity, whichever workload it is.
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

/** Where CD signs in, parsed from the committed binding. */
export type CdStoreCoordinates = Readonly<{
	binding: ParsedInfisicalBinding;
	identityId: string;
}>;

/** Parse the committed binding; a malformed one is refused by name. */
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

/** The committed binding bundled with the function. */
export function readCdStoreCoordinates(
	url: URL = CD_STORE_BINDING_URL,
): CdStoreCoordinates {
	let text: string;
	try {
		text = readFileSync(url, "utf8");
	} catch {
		throw new CdStoreBindingError(
			"cd-store-binding-missing",
			"No store binding is committed for HoBo.CD (deploy/secret-store.binding.json), and no store coordinates are configured. Run hobo cd up, which makes the CD workload identity and configures them.",
		);
	}
	return parseCdStoreCoordinates(text);
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The coordinates `hobo cd up` gives the deployment as its configuration
 * (ids only): the owner's Infisical project, environment and folder, and the
 * CD workload identity it made. Undefined when none are set.
 */
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

/**
 * Where this deployment signs in: the committed binding when there is one,
 * else the configuration `hobo cd up` set. Refused by name when neither is.
 */
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

/** Open the owner's store with the deployment's own OIDC token. */
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
