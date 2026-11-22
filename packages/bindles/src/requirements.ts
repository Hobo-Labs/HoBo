import { createHash } from "node:crypto";
import {
	cloneAsJson,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "./json.js";

import type { BindleDefinition, ProviderAnnotation } from "./types.js";

export const BINDLE_PROVIDER_SELECTION_FORBIDDEN =
	"bindle-provider-selection-forbidden" as const;

export const BINDLE_PROVIDER_SELECTION_REMEDIATION =
	"Provider selection belongs on a Yard. Declare or request a provider-specific Yard and attach this Bindle deployment to it." as const;

const PLATFORM_PROVIDERS = new Set(["hobo", "hobo:build"]);
const PLATFORM_OPTIONS = new Set([
	"cadence",
	"continuity",
	"endpoint",
	"env",
	"health",
	"dependency",
	"session-replay",
	"status-page",
	"webapp",
]);

const BINDLE_REQUIREMENT_KEYS = {
	require: true,
	prefer: true,
	runtimes: true,
	labels: true,
} satisfies Record<keyof BindleRequirements, true>;

export interface BindleRequirements {
	readonly require: readonly string[];
	readonly prefer: readonly string[];
	readonly runtimes: readonly string[];
	readonly labels: Readonly<Record<string, string>>;
}

export type BindleRequirementsHash = `sha256:${string}`;

export function emptyBindleRequirements(): BindleRequirements {
	return Object.freeze({
		require: Object.freeze([] as string[]),
		prefer: Object.freeze([] as string[]),
		runtimes: Object.freeze([] as string[]),
		labels: Object.freeze({}),
	});
}

export function parseBindleRequirements<T>(input: T): BindleRequirements {
	if (input === undefined || input === null) {
		return emptyBindleRequirements();
	}
	const json = cloneAsJson(input);
	if (!isJsonObject(json) || Array.isArray(json)) {
		throw new TypeError("bindle requirements must be an object");
	}
	const raw = json;
	for (const key of Object.keys(raw)) {
		assertProviderNeutralKey(key, "bindle.requirements");
		if (!Object.hasOwn(BINDLE_REQUIREMENT_KEYS, key)) {
			throw new TypeError(`bindle requirements have unknown property: ${key}`);
		}
	}
	const labels = canonicalizeLabels(raw.labels);
	for (const key of Object.keys(labels)) {
		assertProviderNeutralKey(key, "bindle.requirements.labels");
	}
	const require = canonicalizeList(asStringArray(raw.require));
	const prefer = canonicalizeList(asStringArray(raw.prefer));
	const runtimes = canonicalizeList(asStringArray(raw.runtimes));
	for (const item of [...require, ...prefer, ...runtimes]) {
		assertProviderNeutralCapability(item);
	}
	return Object.freeze({
		require,
		prefer,
		runtimes,
		labels,
	});
}

export function hashBindleRequirements(
	requirements: BindleRequirements,
): BindleRequirementsHash {
	const canonical = JSON.stringify({
		labels: requirements.labels,
		prefer: requirements.prefer,
		require: requirements.require,
		runtimes: requirements.runtimes,
	});
	return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function assertNoBindleProviderSelection(
	definition: BindleDefinition,
): void {
	for (const record of Object.values(definition.resources)) {
		for (const annotation of record.annotations) {
			assertAnnotationAllowed(annotation, record.name);
		}
	}
	const anyDef = cloneAsJson(definition);
	if (!isJsonObject(anyDef)) {
		return;
	}
	if (anyDef.provider !== undefined || anyDef.providerId !== undefined) {
		throw bindleProviderForbidden("bindle.provider");
	}
	if (anyDef.resolution !== undefined) {
		throw bindleProviderForbidden("bindle.resolution");
	}
}

export function isPlatformAnnotation(annotation: ProviderAnnotation): boolean {
	if (PLATFORM_OPTIONS.has(annotation.option)) {
		return PLATFORM_PROVIDERS.has(annotation.provider);
	}
	return false;
}

function assertAnnotationAllowed(
	annotation: ProviderAnnotation,
	resourceName: string,
): void {
	if (isPlatformAnnotation(annotation)) {
		for (const key of Object.keys(annotation.config ?? {})) {
			if (
				/^(provider|providerId|resolverId|subscriptionId|accountId|projectId|resourceGroup)$/i.test(
					key,
				)
			) {
				throw bindleProviderForbidden(
					`resource ${resourceName} annotation config.${key}`,
				);
			}
		}
		return;
	}
	throw bindleProviderForbidden(
		`resource ${resourceName} .with({ provider: "${annotation.provider}", option: "${annotation.option}" })`,
	);
}

function assertProviderNeutralKey(key: string, path: string): void {
	if (
		/^(provider|providerId|resolverId|subscriptionId|accountId|projectId|resourceGroup|azure|aws|gcp|cloudflare)$/i.test(
			key,
		) ||
		/^(azure|aws|gcp|cloudflare)\./i.test(key)
	) {
		throw bindleProviderForbidden(`${path}.${key}`);
	}
}

function assertProviderNeutralCapability(value: string): void {
	if (/^(azure|aws|gcp|cloudflare)\./i.test(value)) {
		throw bindleProviderForbidden(`capability ${value}`);
	}
	if (/resolverId|providerId/i.test(value)) {
		throw bindleProviderForbidden(`capability ${value}`);
	}
}

function bindleProviderForbidden(path: string): Error {
	return Object.assign(
		new Error(
			`[${BINDLE_PROVIDER_SELECTION_FORBIDDEN}] ${path}: ${BINDLE_PROVIDER_SELECTION_REMEDIATION}`,
		),
		{
			code: BINDLE_PROVIDER_SELECTION_FORBIDDEN,
			remediation: BINDLE_PROVIDER_SELECTION_REMEDIATION,
			path,
		},
	);
}

function asStringArray(value: JsonValue | undefined): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new TypeError("expected string array");
	}
	return value.map((v) => {
		if (!isJsonString(v)) throw new TypeError("expected string array");
		return v;
	});
}

function canonicalizeList(values: readonly string[]): readonly string[] {
	return Object.freeze([...new Set(values.filter((v) => v.length > 0))].sort());
}

function canonicalizeLabels(
	labels: JsonValue | undefined,
): Readonly<Record<string, string>> {
	if (labels === undefined) {
		return Object.freeze({});
	}
	if (!isJsonObject(labels)) {
		throw new TypeError("bindle requirements labels must be an object");
	}
	const keys = Object.keys(labels).sort();
	const out: Record<string, string> = {};
	for (const key of keys) {
		const value = labels[key];
		if (!isJsonString(value)) {
			throw new TypeError(`label ${key} must be a string`);
		}
		out[key] = value;
	}
	return Object.freeze(out);
}
