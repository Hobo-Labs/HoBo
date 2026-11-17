import { createHash } from "node:crypto";
import { isJsonObject, type JsonObject, type JsonValue } from "../json.js";

// public-contract: capability-manifest document schema ids (Plan 6 signs).
export const MANIFEST_SCHEMA = "hobo.capability-manifest/v1";
// public-contract: capabilities document schema id.
export const CAPABILITIES_SCHEMA = "hobo.capabilities/v1";
// public-contract: auth document schema id.
export const AUTH_SCHEMA = "hobo.provider-auth/v1";
// public-contract: cost document schema id.
export const COST_SCHEMA = "hobo.cost/v1";
// public-contract: the index document's own schema id.
export const MANIFEST_INDEX_SCHEMA = "hobo.capability-manifest-index/v1";

// public-contract: the four well-known pathnames a published manifest occupies.
export const MANIFEST_PATHS = Object.freeze({
	index: "/.well-known/capability-manifest/index.json",
	capabilities: "/.well-known/capability-manifest/capabilities.json",
	auth: "/.well-known/capability-manifest/auth.json",
	cost: "/.well-known/capability-manifest/cost.json",
} as const);

export function canonicalJson(value: JsonValue | undefined): string {
	return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

export function sortKeys<T>(value: T): T {
	if (Array.isArray(value)) {
		return value.map((item) => sortKeys(item)) as T;
	}
	if (value && isJsonObject(value)) {
		return Object.fromEntries(
			Object.entries(value as JsonObject)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, sortKeys(child)]),
		) as T;
	}
	return value;
}

export function stableDigest(value: JsonValue | undefined): string {
	return `sha256:${createHash("sha256")
		.update(JSON.stringify(sortKeys(value)))
		.digest("hex")}`;
}

export function digestRef(seed: string): string {
	return stableDigest({ seed });
}

export interface PublishedManifestParseResult {
	ok: boolean;
	errors: string[];
	index: JsonObject;
	capabilities: JsonObject;
	auth: JsonObject;
	cost: JsonObject;
}

export function parsePublishedManifest(
	documents: Readonly<Record<string, string>>,
): PublishedManifestParseResult {
	const index = JSON.parse(documents[MANIFEST_PATHS.index] ?? "{}");
	const capabilities = JSON.parse(
		documents[MANIFEST_PATHS.capabilities] ?? "{}",
	);
	const auth = JSON.parse(documents[MANIFEST_PATHS.auth] ?? "{}");
	const cost = JSON.parse(documents[MANIFEST_PATHS.cost] ?? "{}");
	const errors: string[] = [];

	if (index.manifestSchema !== MANIFEST_SCHEMA) {
		errors.push(`index.manifestSchema must be ${MANIFEST_SCHEMA}`);
	}
	if (auth.schema !== AUTH_SCHEMA) {
		errors.push(`auth.schema must be ${AUTH_SCHEMA}`);
	}
	if (cost.schema !== COST_SCHEMA) {
		errors.push(`cost.schema must be ${COST_SCHEMA}`);
	}
	if ("staticKey" in auth || "clientSecret" in auth) {
		errors.push("auth must not publish static secrets");
	}
	if (auth.staticSecrets !== false) {
		errors.push("auth.staticSecrets must be false (keyless federation only)");
	}
	if (
		!Array.isArray(capabilities.capabilities) ||
		capabilities.capabilities.length === 0
	) {
		errors.push("capabilities.capabilities must be non-empty");
	}

	return { ok: errors.length === 0, errors, index, capabilities, auth, cost };
}
