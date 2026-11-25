/**
 * Environment network isolation classes and parse-don't-validate boundaries.
 * Soft floor always on; hard-overlay / hard-control-plane optional.
 */

// public-contract: environment network isolation class labels.
import { isJsonString } from "../json.js";

export const ISOLATION_CLASSES = Object.freeze([
	"local-dev",
	"preview",
	"development",
	"staging",
	"production",
	"ephemeral",
] as const);

export type IsolationClass = (typeof ISOLATION_CLASSES)[number];

// public-contract: isolation tier strength.
export const ISOLATION_TIERS = Object.freeze([
	"soft",
	"hard-overlay",
	"hard-control-plane",
] as const);

export type IsolationTier = (typeof ISOLATION_TIERS)[number];

/** Canonical env: tag prefix on subjects/resources. */
// public-contract: env isolation tag prefix.
export const ENV_TAG_PREFIX = "env:" as const;

/** Aliases accepted at parse boundary → canonical IsolationClass. */
const ALIASES: Readonly<Record<string, IsolationClass>> = Object.freeze({
	local: "local-dev",
	"local-dev": "local-dev",
	dev: "development",
	development: "development",
	"remote-dev": "development",
	preview: "preview",
	staging: "staging",
	stage: "staging",
	prod: "production",
	production: "production",
	ephemeral: "ephemeral",
});

/**
 * Parse isolation class from tag list, attributes, or raw string.
 * Returns null when absent (caller decides fail-closed).
 */
export function parseIsolationClass(
	input: string | readonly string[] | undefined | null,
): IsolationClass | null {
	if (input === undefined || input === null) return null;
	if (Array.isArray(input)) {
		for (const tag of input) {
			if (!isJsonString(tag)) continue;
			if (tag.startsWith(ENV_TAG_PREFIX)) {
				const parsed = parseIsolationClass(tag);
				if (parsed) return parsed;
			}
		}
		return null;
	}
	const text = `${input}`;
	const raw = text.startsWith(ENV_TAG_PREFIX)
		? text.slice(ENV_TAG_PREFIX.length)
		: text;
	const key = raw.trim().toLowerCase();
	return ALIASES[key] ?? null;
}

export function isolationClassTag(
	cls: IsolationClass,
): `env:${IsolationClass}` {
	return `${ENV_TAG_PREFIX}${cls}`;
}

/** Default tier recommendation per class. */
export function defaultTierForClass(cls: IsolationClass): IsolationTier {
	switch (cls) {
		case "production":
			return "hard-overlay";
		case "staging":
			return "soft";
		case "local-dev":
			return "hard-control-plane"; // air-gap: no remote overlay
		case "preview":
		case "ephemeral":
			return "soft";
		default:
			return "soft";
	}
}

/** Classes that auto-revoke / short TTL by default. */
export function isShortLivedClass(cls: IsolationClass): boolean {
	return cls === "preview" || cls === "ephemeral";
}

/** Default max membership TTL seconds for short-lived classes. */
export const SHORT_LIVED_MEMBERSHIP_TTL_SECONDS = 86_400; // 24h

/** Default elevated capability TTL (seconds). */
export const ELEVATED_CAPABILITY_TTL_SECONDS = 1_800; // 30m

/** Default break-glass TTL (seconds). */
export const BREAK_GLASS_TTL_SECONDS = 3_600; // 1h

export function isExpired(expiresAt: string | undefined, now: string): boolean {
	if (!expiresAt) return false;
	return Date.parse(expiresAt) <= Date.parse(now);
}

export function classesDiffer(
	a: IsolationClass | null,
	b: IsolationClass | null,
): boolean {
	if (a === null || b === null) return true; // missing → treat as mismatch (fail-closed)
	return a !== b;
}
