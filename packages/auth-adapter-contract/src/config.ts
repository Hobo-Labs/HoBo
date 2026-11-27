/**
 * The authored-config parse boundary for the Better Auth adapter.
 *
 * `parseBetterAuthConfig` is the only door: an authored object goes in, a frozen
 * derived domain record comes out, and there is no intermediate "mostly valid"
 * state a caller could observe. Parse, don't validate — the returned
 * `BetterAuthConfig` is the type the rest of the platform plans against, so a
 * raw authored literal can never be substituted for a checked one downstream.
 *
 * The refusals here are deliberate, not defensive:
 * - an inline secret is refused because the app must never hold signing material
 *   (ADR-0113 / ADR-0161); only a brokered locator is representable;
 * - a missing `basePath` is refused because the bundle mounts routes on the
 *   declared `api()`/`web()` surface and a guessed mount point would silently
 *   collide with app routes;
 * - unknown keys are refused rather than dropped, because a silently ignored
 *   option reads as a supported one and that is the overclaim this repo forbids.
 */

import {
	BetterAuthConfigError,
	type BetterAuthConfigErrorCode,
} from "./errors.js";
import { AUTH_ADAPTER_CONTRACT, BETTER_AUTH_ADAPTER_ID } from "./ids.js";
import {
	isJsonBoolean,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import {
	type BetterAuthSecretRef,
	parseBetterAuthSecretRef,
} from "./secret-locator.js";

/** Authored shape. Compare with {@link BetterAuthConfig}, the parsed shape. */
export interface BetterAuthConfigInput {
	readonly basePath: string;
	readonly secretRef: string;
	readonly database: { readonly profile: string };
	readonly emailAndPassword?: { readonly enabled: boolean };
	readonly socialProviders?: readonly string[];
	readonly organizations?: { readonly enabled: boolean };
}

/** Parsed, frozen, defaults resolved. Only `parseBetterAuthConfig` mints one. */
export interface BetterAuthConfig {
	readonly contract: typeof AUTH_ADAPTER_CONTRACT;
	readonly adapterId: typeof BETTER_AUTH_ADAPTER_ID;
	readonly basePath: string;
	readonly secretRef: BetterAuthSecretRef;
	readonly database: { readonly profile: string };
	readonly emailAndPassword: { readonly enabled: boolean };
	readonly socialProviders: readonly string[];
	readonly organizations: { readonly enabled: boolean };
}

const CONFIG_KEYS = Object.freeze([
	"basePath",
	"database",
	"emailAndPassword",
	"organizations",
	"secretRef",
	"socialProviders",
] as const);

/**
 * Keys that name credential material. `secretRef` is exempt because it is a
 * locator by construction — every other match is somebody pasting a value.
 * Mirrors the `assertNoCredentials` screen used across the workspace.
 */
const CREDENTIAL_KEY =
	/(secret|password|token|credential|private[_-]?key|api[_-]?key)/iu;

/**
 * A mount path: absolute, slash-separated, no traversal, no query or fragment.
 * Better Auth's own convention is `/api/auth`.
 */
const BASE_PATH = /^(?:\/[a-z0-9][a-z0-9._~-]*)+$/u;

/** ADR-0151 capability-profile grammar, narrowed to the data primitive family. */
const DATA_PROFILE = /^data\.[a-z0-9-]+(?:\.[a-z0-9-]+)*\/v[1-9][0-9]*$/u;

/** A social-provider slug, e.g. `github`, `google`, `microsoft-entra`. */
const SOCIAL_PROVIDER = /^[a-z][a-z0-9-]*$/u;

function refuse(
	code: BetterAuthConfigErrorCode,
	message: string,
	remediation: string,
): never {
	throw new BetterAuthConfigError(code, message, remediation);
}

function expectObject<T>(value: T, field: string): JsonObject {
	if (!isJsonObject(value) || value === null || Array.isArray(value)) {
		refuse(
			"BETTER_AUTH_CONFIG_SHAPE_INVALID",
			`${field} must be an object`,
			`pass ${field} as a plain object literal`,
		);
	}
	// SAFETY: assertion to `e as JsonObject; } ` is required at this boundary.
	return value as JsonObject;
}

function assertKnownKeys(
	value: JsonObject,
	field: string,
	allowed: readonly string[],
): void {
	const allowedSet = new Set(allowed);
	for (const key of Object.keys(value).sort()) {
		if (allowedSet.has(key)) continue;
		if (CREDENTIAL_KEY.test(key)) {
			// A credential-named key is a pasted value, not a typo. Say so.
			refuse(
				"BETTER_AUTH_SECRET_INLINE",
				`${field}.${key} names credential material; this adapter accepts a secretRef locator only`,
				"remove the inline credential and reference brokered custody through secretRef",
			);
		}
		refuse(
			"BETTER_AUTH_UNKNOWN_FIELD",
			`${field}.${key} is not a recognized Better Auth adapter option`,
			`remove ${key}; recognized options are ${allowed.join(", ")}`,
		);
	}
}

function parseEnabledBlock<T>(
	value: T,
	field: string,
	fallback: boolean,
): { readonly enabled: boolean } {
	if (value === undefined) {
		return Object.freeze({ enabled: fallback });
	}
	const block = expectObject(value, field);
	assertKnownKeys(block, field, ["enabled"]);
	const enabled = block.enabled;
	if (!isJsonBoolean(enabled)) {
		refuse(
			"BETTER_AUTH_CONFIG_SHAPE_INVALID",
			`${field}.enabled must be a boolean`,
			`set ${field}.enabled to true or false, or omit ${field} entirely`,
		);
	}
	return Object.freeze({ enabled });
}

function parseBasePath<T>(value: T): string {
	if (!isJsonString(value) || value.length === 0) {
		refuse(
			"BETTER_AUTH_BASE_PATH_INVALID",
			"basePath is required and must be a non-empty string",
			'set basePath to the route mount point, e.g. "/api/auth"',
		);
	}
	if (!BASE_PATH.test(value)) {
		refuse(
			"BETTER_AUTH_BASE_PATH_INVALID",
			`basePath ${JSON.stringify(value)} is not an absolute, lowercase, traversal-free mount path`,
			'use an absolute lowercase path with no trailing slash, query, or fragment, e.g. "/api/auth"',
		);
	}
	return value;
}

function parseDatabase<T>(value: T): { readonly profile: string } {
	const block = expectObject(value, "database");
	assertKnownKeys(block, "database", ["profile"]);
	const profile = block.profile;
	if (!isJsonString(profile) || !DATA_PROFILE.test(profile)) {
		refuse(
			"BETTER_AUTH_DATABASE_PROFILE_INVALID",
			"database.profile must name a data-family capability profile",
			'set database.profile to a relational capability profile, e.g. "data.relational/v1" (or a refinement such as "data.postgres/v1")',
		);
	}
	return Object.freeze({ profile });
}

function parseSocialProviders<T>(value: T): readonly string[] {
	if (value === undefined) {
		return Object.freeze([]);
	}
	if (!Array.isArray(value)) {
		refuse(
			"BETTER_AUTH_SOCIAL_PROVIDER_INVALID",
			"socialProviders must be an array of provider slugs",
			'pass socialProviders as an array, e.g. ["github", "google"]',
		);
	}
	const slugs = new Set<string>();
	for (const entry of value) {
		if (!isJsonString(entry) || !SOCIAL_PROVIDER.test(entry)) {
			refuse(
				"BETTER_AUTH_SOCIAL_PROVIDER_INVALID",
				"each socialProviders entry must be a lowercase slug",
				'use lowercase provider slugs, e.g. ["github", "google"]; provider credentials are brokered separately and never appear here',
			);
		}
		slugs.add(entry);
	}
	// Deduped and sorted: authoring order must not leak into a planning record.
	return Object.freeze([...slugs].sort());
}

/**
 * Parse an authored Better Auth adapter config.
 *
 * @throws {BetterAuthConfigError} with a `code` and `remediation` for every
 * refusal. Nothing partially parsed is ever returned.
 */
export function parseBetterAuthConfig(input: JsonValue): BetterAuthConfig {
	const raw = expectObject(input, "config");
	assertKnownKeys(raw, "config", CONFIG_KEYS);

	const config: BetterAuthConfig = {
		contract: AUTH_ADAPTER_CONTRACT,
		adapterId: BETTER_AUTH_ADAPTER_ID,
		basePath: parseBasePath(raw.basePath),
		secretRef: parseBetterAuthSecretRef(raw.secretRef),
		database: parseDatabase(raw.database),
		emailAndPassword: parseEnabledBlock(
			raw.emailAndPassword,
			"emailAndPassword",
			true,
		),
		socialProviders: parseSocialProviders(raw.socialProviders),
		organizations: parseEnabledBlock(raw.organizations, "organizations", false),
	};

	return Object.freeze(config);
}
