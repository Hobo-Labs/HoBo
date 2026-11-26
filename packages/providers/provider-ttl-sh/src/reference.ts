/**
 * References, names, TTL windows, and expiry arithmetic.
 *
 * Three facts about ttl.sh drive everything in this module.
 *
 * **There are no accounts.** A repository name belongs to whoever pushed it last,
 * and anyone may pull anything they can name. The name is therefore the only thing
 * standing between an artifact and a stranger, which is why `parseArtifactName`
 * refuses anything guessable — `my-app`, `staging`, `hobo-build` — and accepts only
 * a minted UUID or a full content-addressed `sha256-<64 hex>` name. A friendly name
 * here is not a minor style问题; it is a public artifact with a predictable address.
 *
 * **The TTL is the tag.** `ttl.sh/<name>:1h` *means* "keep this for an hour". There
 * is no lifecycle API and nothing to reconcile: the lifetime is encoded in the
 * reference every consumer already holds. Documented range, checked 2026-08-08
 * against <https://ttl.sh/>: minutes up to a maximum of 24 hours, defaulting to 1h
 * when the tag omits one. This package never relies on that default — an
 * unspecified TTL is a rejected reference, because "whatever the service currently
 * defaults to" is not a lifetime an operator agreed to.
 *
 * **The registry reports no expiry.** So expiry is local arithmetic over the push
 * instant, which arrives as a parameter. Nothing here reads a clock.
 */
import { TtlShProviderError } from "./errors.js";

/** The one origin this package speaks to. Not a namespace: no subdomains. */
// public-contract: registry host accepted by reference parsers.
export const TTL_SH_REGISTRY_HOST = "ttl.sh" as const;

/** The documented ceiling, in minutes. */
export const TTL_SH_MAX_TTL_MINUTES = 24 * 60;

/** Whole minutes are the finest granularity the service documents. */
export const TTL_SH_MIN_TTL_MINUTES = 1;

/**
 * The service's documented default when a tag omits a TTL. Recorded so a refusal
 * can cite it; nothing in this package applies it.
 */
export const TTL_SH_DOCUMENTED_DEFAULT_MINUTES = 60;

/**
 * Upper bound on a whole reference string.
 *
 * Generous enough for the longest name this package mints — a content-addressed
 * `sha256-<64 hex>` plus host and tag — and short enough that a runaway string is
 * refused as malformed before any of the more specific parsers try to interpret it.
 */
export const MAX_REFERENCE_LENGTH = 128;

function invalidReference(detail: string): never {
	throw new TtlShProviderError("INVALID_IMAGE_REFERENCE", detail);
}

function ttlOutOfRange(detail: string): never {
	throw new TtlShProviderError("TTL_OUT_OF_RANGE", detail);
}

function guessableName(detail: string): never {
	throw new TtlShProviderError("GUESSABLE_ARTIFACT_NAME", detail);
}

declare const digestBrand: unique symbol;

/** `sha256:` plus 64 lowercase hex characters. */
export type TtlShDigest = string & { readonly [digestBrand]: "TtlShDigest" };

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

export function parseArtifactDigest(input: string): TtlShDigest {
	if (!DIGEST.test(input)) {
		invalidReference(
			"digest must be sha256: followed by 64 lowercase hex characters",
		);
	}
	// SAFETY: input matched sha256: plus 64 lowercase hex characters.
	return input as TtlShDigest;
}

/**
 * How a name was derived.
 *
 * Both accepted kinds are unguessable, and they differ in what they promise. A
 * `uuid` name is unique per push. A `content-addressed` name is a pure function of
 * the digest, so two pushes of identical bytes land on the same reference — which
 * is what makes an idempotent re-push possible at all.
 */
export type TtlShNameKind = "uuid" | "content-addressed";

export type TtlShArtifactName = {
	readonly name: string;
	readonly nameKind: TtlShNameKind;
};

// Lowercase only. An uppercase UUID is a *different* repository on a registry that
// lowercases nothing, so accepting it would push to an address the caller did not
// mean.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CONTENT_ADDRESSED = /^sha256-[0-9a-f]{64}$/u;

/**
 * Parse a repository name, refusing anything a stranger could guess.
 *
 * The refusal is the interesting half. `parseArtifactName("staging")` fails not
 * because the string is malformed but because on an unauthenticated registry a
 * memorable name is a public address: whoever tries it first can read the artifact,
 * and whoever pushes to it next replaces it.
 */
export function parseArtifactName(input: string): TtlShArtifactName {
	if (input.length === 0 || input.length > 71) {
		invalidReference("artifact name must be 1-71 characters");
	}
	if (UUID.test(input)) return { name: input, nameKind: "uuid" };
	if (CONTENT_ADDRESSED.test(input))
		return { name: input, nameKind: "content-addressed" };
	guessableName(
		`artifact name ${JSON.stringify(input)} is guessable; ttl.sh is unauthenticated in both directions, so the name is the only thing between the artifact and a stranger. Mint a UUID name or derive one from the digest.`,
	);
}

/**
 * A TTL window inside the documented bounds, carrying the exact tag text.
 *
 * The text is kept rather than re-rendered because it is what the registry reads,
 * and because `90m` and `1h30m` are not interchangeable as far as this package is
 * concerned — only the form that was validated is used.
 */
export type TtlWindow = {
	readonly minutes: number;
	/** The tag text: `5m`, `90m`, `1h`, `24h`. */
	readonly text: string;
};

// No leading zeros, one unit, minutes or hours only. `1d` and `30s` are units the
// service does not document, and translating them here would be inventing a
// contract.
const TTL_TAG = /^(?:0|[1-9][0-9]{0,3})(h|m)$/u;

export function parseTtlWindow(input: string): TtlWindow {
	if (input.length === 0) {
		ttlOutOfRange(
			`ttl tag is empty; ttl.sh would apply its documented ${TTL_SH_DOCUMENTED_DEFAULT_MINUTES} minute default, which is not a lifetime this transport assumes on a caller's behalf`,
		);
	}
	const match = TTL_TAG.exec(input);
	if (match === null) {
		ttlOutOfRange(
			`ttl tag ${JSON.stringify(input)} is not a documented ttl.sh window; use <n>m or <n>h with no leading zeros`,
		);
	}
	const unit = match[1];
	const value = Number(input.slice(0, -1));
	const minutes = unit === "h" ? value * 60 : value;
	if (minutes < TTL_SH_MIN_TTL_MINUTES) {
		ttlOutOfRange(
			"ttl must be at least 1 minute; an artifact that expires on arrival is a mistake",
		);
	}
	if (minutes > TTL_SH_MAX_TTL_MINUTES) {
		// Refused rather than clamped: a caller planning around 48 hours is
		// planning around a lease that will not exist.
		ttlOutOfRange(
			`ttl of ${minutes} minutes exceeds the documented 24 hour maximum; ttl.sh would clamp it and the caller would believe a lifetime it does not have`,
		);
	}
	return { minutes, text: input };
}

/**
 * A reference that can be pushed to and pulled from.
 *
 * Carries the parsed name kind and TTL rather than leaving them in the string, so
 * nothing downstream re-reads a tag to learn when the artifact goes away.
 */
// domain-view: the parsed reference pins the host to a literal type, carries the parsed name kind and TtlWindow rather than a tag string, and derives pullReference; the proto message is its wire form.
export type TtlShImageReference = {
	readonly host: typeof TTL_SH_REGISTRY_HOST;
	readonly name: string;
	readonly nameKind: TtlShNameKind;
	readonly ttl: TtlWindow;
	/** `ttl.sh/<name>:<ttl>`. */
	readonly pullReference: string;
};

function makeReference(
	parsedName: TtlShArtifactName,
	ttl: TtlWindow,
): TtlShImageReference {
	return {
		host: TTL_SH_REGISTRY_HOST,
		name: parsedName.name,
		nameKind: parsedName.nameKind,
		ttl,
		pullReference: `${TTL_SH_REGISTRY_HOST}/${parsedName.name}:${ttl.text}`,
	};
}

/** Build a reference from parts, through the same checks a raw string gets. */
export function createTtlShImageReference(input: {
	readonly name: string;
	readonly ttl: string;
}): TtlShImageReference {
	return makeReference(
		parseArtifactName(input.name),
		parseTtlWindow(input.ttl),
	);
}

/**
 * Parse a reference that arrived from outside — a CI variable, an event body, a
 * previous run's receipt.
 *
 * A reference for any other host is refused as `TRANSPORT_NOT_ALLOWED` rather than
 * as a malformed string, because the failure mode is not a parse error: the push
 * carries no credential, so a wrong host does not fail. It succeeds somewhere that
 * keeps the layers.
 */
export function parseTtlShImageReference(input: string): TtlShImageReference {
	if (input.length === 0) invalidReference("reference is empty");
	if (input.length > MAX_REFERENCE_LENGTH) {
		invalidReference(`reference exceeds ${MAX_REFERENCE_LENGTH} characters`);
	}
	if (input.trim() !== input) {
		invalidReference("reference has surrounding whitespace");
	}
	if (input.includes("://")) {
		invalidReference(
			"reference must not carry a scheme; it is a registry reference, not a URL",
		);
	}
	const slash = input.indexOf("/");
	if (slash === -1) {
		invalidReference(
			`reference must be shaped ${TTL_SH_REGISTRY_HOST}/<name>:<ttl>`,
		);
	}
	const host = input.slice(0, slash);
	if (host !== TTL_SH_REGISTRY_HOST) {
		throw new TtlShProviderError(
			"TRANSPORT_NOT_ALLOWED",
			`reference names host ${JSON.stringify(host)}; this transport describes ${TTL_SH_REGISTRY_HOST} only, and a push to anywhere else would not fail — it would succeed somewhere that keeps the layers`,
			{ detail: { host } },
		);
	}
	const rest = input.slice(slash + 1);
	if (rest.includes("/")) {
		invalidReference(
			"ttl.sh addresses artifacts as ttl.sh/<name>; a nested repository path is another registry's convention",
		);
	}
	if (rest.includes("@")) {
		invalidReference(
			"a digest pin cannot be pushed to; push a tagged reference and pin the digest afterwards",
		);
	}
	const colon = rest.indexOf(":");
	if (colon === -1) {
		ttlOutOfRange(
			`reference carries no TTL tag; ttl.sh would apply its documented ${TTL_SH_DOCUMENTED_DEFAULT_MINUTES} minute default, which is not a lifetime this transport assumes on a caller's behalf`,
		);
	}
	return makeReference(
		parseArtifactName(rest.slice(0, colon)),
		parseTtlWindow(rest.slice(colon + 1)),
	);
}

/**
 * The content-addressed name for a digest.
 *
 * A pure function, which is the point: two pushes of identical bytes derive the
 * same reference, so a re-push is an adoption rather than a second lease.
 */
export function contentAddressedNameFor(digest: TtlShDigest): string {
	return digest.replace(":", "-");
}

export function referenceForDigest(
	digest: TtlShDigest,
	ttl: string,
): TtlShImageReference {
	return createTtlShImageReference({
		name: contentAddressedNameFor(digest),
		ttl,
	});
}

/**
 * When the artifact stops existing.
 *
 * Local arithmetic over the push instant: the registry reports no expiry, so a
 * receipt that claimed an authoritative one would be inventing it.
 */
export function expiresAtMs(
	reference: TtlShImageReference,
	pushedAtMs: number,
): number {
	if (!Number.isFinite(pushedAtMs) || pushedAtMs <= 0) {
		invalidReference(
			"push instant must be a positive epoch-millisecond value; an expiry computed from a placeholder would be wrong in the direction that loses artifacts",
		);
	}
	return pushedAtMs + reference.ttl.minutes * 60_000;
}

/** Where the manifest lives on the distribution API. */
export function manifestPath(reference: TtlShImageReference): string {
	return `/v2/${reference.name}/manifests/${reference.ttl.text}`;
}
