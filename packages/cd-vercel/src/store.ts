import { readFileSync } from "node:fs";

import {
	createInfisicalClient,
	createInfisicalSecretsPort,
	infisicalSecretRef,
	type JwtSource,
	oidcAuth,
	type ParsedInfisicalBinding,
	parseInfisicalBinding,
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
		const identityId = record.data.relayIdentityId;
		// Validated by the parser OIDC Auth itself uses; throws on a bad id.
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
			"No store binding is committed for HoBo.CD (deploy/secret-store.binding.json). hobo cd up writes it once the CD workload identity exists.",
		);
	}
	return parseCdStoreCoordinates(text);
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
