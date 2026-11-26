/**
 * Parse, don't validate: the non-secret coordinates of the config service
 * cross this parser once and become a branded `ParsedInfisicalBinding`, the
 * derived type of the generated `InfisicalBinding` record. The patterns are the
 * ones in `data-models/adapter_infisical.cue`.
 */

import type { InfisicalBinding } from "./_generated/adapter_infisical_pb.js";
import { InfisicalError } from "./errors.js";

/** Infisical Cloud (US). EU Cloud is `https://eu.infisical.com`. */
// public-contract: the default INFISICAL_SITE_URL that deployments and docs name.
export const INFISICAL_CLOUD_SITE_URL = "https://app.infisical.com";

declare const bindingBrand: unique symbol;
declare const identityBrand: unique symbol;
declare const secretKeyBrand: unique symbol;

export type ParsedInfisicalBinding = Readonly<
	Pick<InfisicalBinding, "siteUrl" | "projectId" | "environment" | "secretPath">
> & { readonly [bindingBrand]: "InfisicalBinding" };

/** A machine identity id (Infisical shows it on the identity's page). */
export type InfisicalIdentityId = string & {
	readonly [identityBrand]: "InfisicalIdentityId";
};

/** A secret key that is also a valid `infisical://` SecretRef segment. */
export type InfisicalSecretKey = string & {
	readonly [secretKeyBrand]: "InfisicalSecretKey";
};

const PROJECT_ID = /^[A-Za-z0-9-]{1,64}$/u;
const ENVIRONMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const SECRET_PATH = /^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/u;
const SECRET_KEY = /^[A-Za-z0-9_.-]{1,256}$/u;
const IDENTITY_ID = /^[A-Za-z0-9-]{1,64}$/u;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function invalid(field: string): never {
	throw new InfisicalError(`binding ${field}`, "invalid-input");
}

function siteUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return invalid("siteUrl");
	}
	const loopbackHttp =
		url.protocol === "http:" && LOOPBACK.has(url.hostname.toLowerCase());
	if (
		(url.protocol !== "https:" && !loopbackHttp) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.pathname !== "/" && url.pathname !== "")
	)
		return invalid("siteUrl");
	return url.origin;
}

export function parseInfisicalBinding(input: {
	readonly siteUrl?: string | undefined;
	readonly projectId: string | undefined;
	readonly environment: string | undefined;
	readonly secretPath?: string | undefined;
}): ParsedInfisicalBinding {
	const site = siteUrl(input.siteUrl || INFISICAL_CLOUD_SITE_URL);
	const projectId = input.projectId ?? "";
	if (!PROJECT_ID.test(projectId)) invalid("projectId");
	const environment = input.environment ?? "";
	if (!ENVIRONMENT.test(environment)) invalid("environment");
	let secretPath = input.secretPath || "/";
	if (secretPath.length > 1 && secretPath.endsWith("/"))
		secretPath = secretPath.slice(0, -1);
	if (secretPath.length > 512 || !SECRET_PATH.test(secretPath))
		invalid("secretPath");
	// SAFETY: every field matched its CUE pattern above.
	return Object.freeze({
		siteUrl: site,
		projectId,
		environment,
		secretPath,
	}) as ParsedInfisicalBinding;
}

/**
 * The binding a deployment declares in its environment. These are plain
 * configuration, not secrets: `INFISICAL_SITE_URL` (default Infisical Cloud),
 * `INFISICAL_PROJECT_ID`, `INFISICAL_ENVIRONMENT`, `INFISICAL_SECRET_PATH`.
 */
export function infisicalBindingFromEnv(
	env: Readonly<Record<string, string | undefined>>,
): ParsedInfisicalBinding {
	return parseInfisicalBinding({
		siteUrl: env.INFISICAL_SITE_URL,
		projectId: env.INFISICAL_PROJECT_ID,
		environment: env.INFISICAL_ENVIRONMENT,
		secretPath: env.INFISICAL_SECRET_PATH,
	});
}

export function parseInfisicalIdentityId(
	value: string | undefined,
): InfisicalIdentityId {
	if (value === undefined || !IDENTITY_ID.test(value)) invalid("identityId");
	// SAFETY: matched IDENTITY_ID above.
	return value as InfisicalIdentityId;
}

export function parseInfisicalSecretKey(value: string): InfisicalSecretKey {
	if (!SECRET_KEY.test(value) || value === "." || value === "..")
		invalid("secretKey");
	// SAFETY: matched SECRET_KEY above and is not a traversal segment.
	return value as InfisicalSecretKey;
}
