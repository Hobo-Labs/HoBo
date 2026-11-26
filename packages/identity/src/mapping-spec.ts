/**
 * MappingSpec: versioned claim + subject mapping for continuous identity migration.
 * Platform-derived preferred; validated at can-migrate. Apps never write mapping logic.
 */

import { createHash } from "node:crypto";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

// public-contract: MappingSpec schema version.
export const MAPPING_SPEC_SCHEMA_VERSION =
	"hobo.identity-mapping-spec/v1" as const;

export type ClaimMapping = Readonly<{
	/** Source claim key (e.g. sub, email, tenant). */
	from: string;
	/** Target claim key. */
	to: string;
	/** Required for dual-consistency (fail-closed if missing/divergent). */
	critical: boolean;
	/** Optional transform: identity | lowercase | principal-ref */
	transform?: "identity" | "lowercase" | "principal-ref";
}>;

export type MappingSpec = Readonly<{
	schemaVersion: typeof MAPPING_SPEC_SCHEMA_VERSION;
	id: string;
	version: string;
	contentHash: `sha256:${string}`;
	sourceAdapter: string;
	targetAdapter: string;
	claimMappings: readonly ClaimMapping[];
	/** Subject claim that anchors PrincipalRef continuity (usually "sub"). */
	principalSubjectClaim: string;
	/** When true, dual verification may drop non-critical claim drift. */
	allowNonCriticalDrift: boolean;
}>;

export type MappingSpecInput = Readonly<{
	id: string;
	version: string;
	sourceAdapter: string;
	targetAdapter: string;
	claimMappings: readonly ClaimMapping[];
	principalSubjectClaim?: string;
	allowNonCriticalDrift?: boolean;
}>;

function canonicalize<T>(value: T): string {
	if (value === null || value === undefined || !isJsonObject(value)) {
		return JSON.stringify(value ?? null);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalize).join(",")}]`;
	}
	// SAFETY: assertion to `value as JsonObject` is required at this boundary.
	const obj = value as JsonObject;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

/**
 * Parse-don't-validate MappingSpec boundary.
 */
export function parseMappingSpec(input: MappingSpecInput): MappingSpec {
	if (!isJsonString(input.id) || input.id.length === 0) {
		throw new TypeError("MappingSpec.id required");
	}
	if (!isJsonString(input.version) || input.version.length === 0) {
		throw new TypeError("MappingSpec.version required");
	}
	if (!isJsonString(input.sourceAdapter) || input.sourceAdapter.length === 0) {
		throw new TypeError("MappingSpec.sourceAdapter required");
	}
	if (!isJsonString(input.targetAdapter) || input.targetAdapter.length === 0) {
		throw new TypeError("MappingSpec.targetAdapter required");
	}
	if (input.sourceAdapter === input.targetAdapter) {
		throw new TypeError("MappingSpec source and target adapters must differ");
	}
	if (!Array.isArray(input.claimMappings) || input.claimMappings.length === 0) {
		throw new TypeError("MappingSpec.claimMappings must be non-empty");
	}
	const claimMappings = Object.freeze(
		input.claimMappings.map((m) => {
			if (!m?.from || !m?.to) {
				throw new TypeError("claim mapping requires from and to");
			}
			return Object.freeze({
				from: m.from,
				to: m.to,
				critical: m.critical === true,
				...(m.transform !== undefined ? { transform: m.transform } : undefined),
			});
		}),
	);
	const principalSubjectClaim = input.principalSubjectClaim ?? "sub";
	const body = {
		schemaVersion: MAPPING_SPEC_SCHEMA_VERSION,
		id: input.id,
		version: input.version,
		sourceAdapter: input.sourceAdapter,
		targetAdapter: input.targetAdapter,
		claimMappings,
		principalSubjectClaim,
		allowNonCriticalDrift: input.allowNonCriticalDrift === true,
	};
	const contentHash =
		`sha256:${createHash("sha256").update(canonicalize(body)).digest("hex")}` as const;
	return Object.freeze({ ...body, contentHash });
}

/** Platform default: continuous dual path for any adapter change. */
export function defaultContinuousMappingSpec(input: {
	readonly sourceAdapter: string;
	readonly targetAdapter: string;
	readonly id?: string;
}): MappingSpec {
	return parseMappingSpec({
		id: input.id ?? `map:${input.sourceAdapter}->${input.targetAdapter}`,
		version: "1.0.0",
		sourceAdapter: input.sourceAdapter,
		targetAdapter: input.targetAdapter,
		claimMappings: Object.freeze([
			Object.freeze({
				from: "sub",
				to: "sub",
				critical: true,
				transform: "principal-ref" as const,
			}),
			Object.freeze({
				from: "tenant",
				to: "tenant",
				critical: true,
				transform: "identity" as const,
			}),
			Object.freeze({
				from: "email",
				to: "email",
				critical: false,
				transform: "lowercase" as const,
			}),
		]),
		principalSubjectClaim: "sub",
		allowNonCriticalDrift: true,
	});
}

export function applyClaimTransform(
	value: JsonValue,
	transform: ClaimMapping["transform"] = "identity",
): string {
	const raw = String(value ?? "");
	switch (transform) {
		case "lowercase":
			return raw.toLowerCase();
		case "principal-ref":
			// Opaque stable ref segment — never the raw IdP subject in app code.
			return createHash("sha256")
				.update(`principal:${raw}`)
				.digest("hex")
				.slice(0, 32);
		default:
			return raw;
	}
}
