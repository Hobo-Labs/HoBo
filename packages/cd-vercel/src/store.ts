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

export class CdStoreBindingError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "CdStoreBindingError";
		this.code = code;
	}
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
		const identityId = record.data.relayIdentityId;
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
	} catch {
		throw new CdStoreBindingError(
			"cd-store-binding-missing",
			"No store binding is committed for HoBo.CD (deploy/secret-store.binding.json). hobo cd up writes it once the CD workload identity exists.",
		);
	}
	return parseCdStoreCoordinates(text);
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
