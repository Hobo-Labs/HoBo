
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

// public-contract: env isolation tag prefix.
export const ENV_TAG_PREFIX = "env:" as const;

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

export function defaultTierForClass(cls: IsolationClass): IsolationTier {
	switch (cls) {
		case "production":
			return "hard-overlay";
		case "staging":
			return "soft";
		case "local-dev":
			return "hard-control-plane";
		case "preview":
		case "ephemeral":
			return "soft";
		default:
			return "soft";
	}
}

export function isShortLivedClass(cls: IsolationClass): boolean {
	return cls === "preview" || cls === "ephemeral";
}

export const SHORT_LIVED_MEMBERSHIP_TTL_SECONDS = 86_400;

export const ELEVATED_CAPABILITY_TTL_SECONDS = 1_800;

export const BREAK_GLASS_TTL_SECONDS = 3_600;

export function isExpired(expiresAt: string | undefined, now: string): boolean {
	if (!expiresAt) return false;
	return Date.parse(expiresAt) <= Date.parse(now);
}

export function classesDiffer(
	a: IsolationClass | null,
	b: IsolationClass | null,
): boolean {
	if (a === null || b === null) return true;
	return a !== b;
}
