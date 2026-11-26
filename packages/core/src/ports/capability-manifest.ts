/**
 * Codec for the published `/.well-known/capability-manifest/*` documents.
 *
 * Eight provider packages each carried their own byte-identical copy of this:
 * the same canonical-JSON writer, the same digest walk, and in four cases the
 * same parser. They belong here because the schema ids below are *platform*
 * contract, not any one provider's concern — a provider that spells
 * `hobo.capabilities/v1` differently is broken, not customised.
 *
 * `canonicalJson` was moved verbatim and must stay that way: its output is what
 * every digest is computed over, so a "tidier" rewrite that reorders a key or
 * drops the trailing newline changes every digest silently.
 *
 * `stableDigest` was **not** kept as-is, and the reasoning is worth recording
 * because the previous comment here argued the opposite. It used to be a 32-bit
 * FNV-ish walk emitting `fnv:` + 8 hex digits, described as "not a security
 * primitive". That description was accurate and that was the problem: these
 * documents are fetched from a **provider-controlled origin**, so a
 * document-integrity reference an attacker can collide by brute force in
 * milliseconds is not integrity, it is a typo detector. Three runner packages
 * had already reached the same conclusion independently and used SHA-256.
 *
 * The reason given for keeping FNV — that changing it would invalidate
 * published references — did not survive being checked. Nothing in the repo
 * verifies these values (`runner-github` checks only that the field is a
 * non-empty string), and no manifest has ever been published from here to a
 * live provider. The cost of converging was zero and the cost of not
 * converging was two algorithms behind one name.
 */

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

/** Deterministic JSON: keys sorted at every depth, 2-space indent, trailing newline. */
export function canonicalJson(value: JsonValue | undefined): string {
	return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

/**
 * Key-sorted at every depth, arrays left in order.
 *
 * Exported because it is the canonical form itself, not an implementation
 * detail of the writer: a caller that wants a deterministically-ordered
 * *object* (rather than a string) needs exactly this, and reimplementing it
 * is how the two spellings drift apart.
 */
export function sortKeys<T>(value: T): T {
	if (Array.isArray(value)) {
		// SAFETY: assertion required at this I/O or test boundary.
		return value.map((item) => sortKeys(item)) as T;
	}
	if (value && isJsonObject(value)) {
		// SAFETY: assertion required at this I/O or test boundary.
		return Object.fromEntries(
			// SAFETY: assertion required at this I/O or test boundary.
			Object.entries(value as JsonObject)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, sortKeys(child)]),
		) as T;
	}
	return value;
}

/**
 * SHA-256 over the canonical form, for document-integrity references inside the
 * published bundle (the Registry hashes the index separately).
 *
 * Collision resistance is the point: the bundle is fetched from an origin the
 * provider controls, so a reference that only detects accidental corruption
 * lets a hostile origin serve a different document under the indexed digest.
 */
export function stableDigest(value: JsonValue | undefined): string {
	return `sha256:${createHash("sha256")
		.update(JSON.stringify(sortKeys(value)))
		.digest("hex")}`;
}

/**
 * A digest over a seed string, for cost-fact source references.
 *
 * The wrapping object is kept because it is what the providers already emit;
 * unwrapping it would change every reference for no gain.
 */
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

/**
 * Parse-don't-validate boundary: untrusted well-known manifest documents become
 * a parsed derived type or structured errors — no broad DTO checks downstream.
 *
 * The two auth checks are the load-bearing ones. A manifest is fetched from a
 * provider-controlled origin, so `staticKey`/`clientSecret` appearing at all
 * means either the provider is publishing a credential or something upstream
 * rewrote the document; both are refusals, not warnings.
 */
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
