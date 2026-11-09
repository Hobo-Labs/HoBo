import { toJson, toJsonString } from "@bufbuild/protobuf";
import {
	CiPolicyProviderSchema,
	ciBudgetPolicyJson,
	DesiredCiPolicySchema,
	type ParsedCiPolicy,
	parseCiPolicy,
} from "@hobo/ci";
import {
	parseBudgetPolicyDocumentJson,
	parseBudgetPolicyJson,
} from "@hobo/core";
import { z } from "zod";
import { createCiRelayClient } from "./client.js";
import {
	parseEnvironmentEngineList,
	parseEnvironmentEngineRelays,
} from "./engine-relay-routing.js";
import {
	CiProjectDocumentSchema,
	resolveCiProjectReferences,
} from "./project-schema.js";
import {
	findRawSecrets,
	type RunnerIntegration,
	RunnerIntegrationsSchema,
} from "./runner-integrations.js";

const environmentName = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ExplicitEnvironment = z.string().regex(environmentName);
const validatedConfigs = new WeakSet<CiProjectConfig>();
const SecretRequirement = z
	.object({
		requiredFor: z
			.array(z.enum(["deployment", "execution"]))
			.min(1)
			.max(2)
			.refine((phases) => new Set(phases).size === phases.length),
	})
	.strict();
const SecretDeclarations = z
	.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), SecretRequirement)
	.refine((secrets) => Object.keys(secrets).length <= 64);
const ProtobufPolicyProvider = z
	.object({ $typeName: z.literal("hobo.ci.v1.CiPolicyProvider") })
	.loose();
const JsonValue = z.json();
const JsonObject = z.record(z.string(), JsonValue);
type JsonData = z.infer<typeof JsonValue>;
const JobAdmission = z.enum(["push", "pull"]);
const WorkerStore = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("sqlite") }).strict(),
	z
		.object({
			kind: z.literal("postgres"),
			urlEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
		})
		.strict(),
]);
const CiEngineId = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const EngineRelayOverride = z
	.object({
		relayOrigin: z.string().min(1).max(2048).optional(),
	})
	.strict();
export const EnvironmentEngineRelaysSchema = z
	.record(CiEngineId, EngineRelayOverride)
	.refine((entries) => Object.keys(entries).length <= 16);
export const EnvironmentEnginesSchema = z.union([
	z.array(CiEngineId).max(16),
	z
		.record(CiEngineId, EngineRelayOverride.partial())
		.refine((entries) => Object.keys(entries).length <= 16),
]);
const EnvironmentFields = z
	.object({
		relayOrigin: z.string().min(1).max(2048),
		githubWebhookOrigin: z.string().min(1).max(2048).optional(),
		allowInsecureLoopback: z.boolean().optional(),
		jobAdmission: JobAdmission.optional(),
		store: WorkerStore.optional(),
		engines: EnvironmentEnginesSchema.optional(),
		engineRelays: EnvironmentEngineRelaysSchema.optional(),
		secrets: SecretDeclarations.optional(),
		policy: JsonValue,
	})
	.strict();
const EnvironmentTemplate = EnvironmentFields.partial();
const ProjectInput = z
	.object({
		defaultEnvironment: z.string().regex(environmentName).optional(),
		templates: z
			.record(z.string().regex(environmentName), EnvironmentTemplate)
			.refine((templates) => Object.keys(templates).length <= 32)
			.optional(),
		environments: z
			.record(
				z.string().regex(environmentName),
				EnvironmentTemplate.extend({
					extends: ExplicitEnvironment.optional(),
				}).strict(),
			)
			.optional(),
	})
	.strict();

export interface CiProjectEnvironment {
	readonly name: string;
	readonly relayOrigin: string;
	/** Declared public GitHub ingress; reachability and registration are separate. */
	readonly githubWebhookOrigin: string | undefined;
	readonly allowInsecureLoopback: boolean;
	/** Push accepts signed GitHub webhooks at the relay; pull polls GitHub for queued jobs. */
	readonly jobAdmission: "push" | "pull" | undefined;
	/** Box worker lease journal; undefined means local SQLite. Postgres carries an env var name, never a URL. */
	readonly store: CiWorkerStore | undefined;
	/** Engines served from this environment profile (defaults to repository inventory). */
	readonly engines: readonly string[] | undefined;
	/** Per-engine relay origin overrides (falls back to environment relayOrigin). */
	readonly engineRelays:
		| Readonly<Record<string, { readonly relayOrigin?: string }>>
		| undefined;
	/** Logical names and required phases only; secret values are never configured here. */
	readonly secrets: Readonly<Record<string, CiSecretRequirement>>;
	readonly policy: ParsedCiPolicy;
}

export type CiWorkerStore =
	| { readonly kind: "sqlite" }
	| { readonly kind: "postgres"; readonly urlEnv: string };

export type CiSecretPhase = "deployment" | "execution";
export interface CiSecretRequirement {
	readonly requiredFor: readonly CiSecretPhase[];
}

export interface CiProjectConfig {
	readonly defaultEnvironment: string;
	readonly environments: Readonly<Record<string, CiProjectEnvironment>>;
}

interface LegacyCiProjectConfigInput {
	defaultEnvironment?: string;
	templates?: Record<string, CiProjectEnvironmentTemplate>;
	environments?: Record<string, CiProjectEnvironmentInput>;
}

export type CiProjectConfigInput =
	| LegacyCiProjectConfigInput
	| z.input<typeof CiProjectDocumentSchema>;

type DeepPartial<T> = T extends readonly unknown[]
	? T
	: T extends object
		? { [K in keyof T]?: DeepPartial<T[K]> }
		: T;
export interface CiProjectEnvironmentTemplate {
	relayOrigin?: string;
	githubWebhookOrigin?: string;
	allowInsecureLoopback?: boolean;
	jobAdmission?: "push" | "pull";
	store?: CiWorkerStore;
	secrets?: Readonly<
		Record<string, { readonly requiredFor: readonly CiSecretPhase[] }>
	>;
	policy?: DeepPartial<Parameters<typeof import("@hobo/ci").defineCiPolicy>[0]>;
}
export type CiProjectEnvironmentInput = CiProjectEnvironmentTemplate &
	(
		| { extends: string }
		| {
				extends?: never;
				relayOrigin: string;
				policy: Parameters<typeof import("@hobo/ci").defineCiPolicy>[0];
		  }
	);

/** Merge data only; arrays and primitives replace the inherited value. */
function mergeTemplate(
	base: JsonData,
	override: JsonData,
	depth = 0,
): JsonData {
	if (depth > 32) throw new Error("template nesting too deep");
	const baseObject = JsonObject.safeParse(base);
	const overrideObject = JsonObject.safeParse(override);
	if (!baseObject.success || !overrideObject.success) return override;
	const entries = new Map(Object.entries(baseObject.data));
	for (const [key, value] of Object.entries(overrideObject.data)) {
		if (key === "__proto__" || key === "constructor" || key === "prototype")
			throw new Error("invalid template key");
		const inherited = entries.get(key);
		entries.set(
			key,
			inherited === undefined || key === "budgetPolicy"
				? value
				: mergeTemplate(inherited, value, depth + 1),
		);
	}
	return Object.fromEntries(entries);
}

function projectConfig(
	defaultEnvironment: string,
	environments: Readonly<Record<string, CiProjectEnvironment>>,
): CiProjectConfig {
	const entries = Object.values(environments);
	if (
		entries.length === 0 ||
		entries.length > 32 ||
		!Object.hasOwn(environments, defaultEnvironment)
	)
		throw new Error("invalid environment selection");
	const targets = new Set<string>();
	for (const entry of entries) {
		const origins = [entry.relayOrigin];
		for (const override of Object.values(entry.engineRelays ?? {}))
			if (override.relayOrigin) origins.push(override.relayOrigin);
		for (const origin of origins) {
			const key = JSON.stringify([origin, entry.policy.accountId]);
			if (targets.has(key)) throw new Error("duplicate environment account");
			targets.add(key);
		}
	}
	const config = Object.freeze({
		defaultEnvironment,
		environments: Object.freeze({ ...environments }),
	});
	validatedConfigs.add(config);
	return config;
}

function relayOrigin(value: string, allowInsecureLoopback: boolean): string {
	const url = new URL(value);
	const loopback =
		allowInsecureLoopback &&
		url.protocol === "http:" &&
		(url.hostname === "localhost" || url.hostname === "127.0.0.1");
	if (
		(!loopback && url.protocol !== "https:") ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new Error("invalid relay origin");
	return url.origin;
}

/** Refuse destinations GitHub cannot reach as literals; DNS is not verified. */
function githubWebhookOrigin(value: string): string {
	const normalized = relayOrigin(value, false);
	const host = new URL(normalized).hostname.toLowerCase().replace(/\.$/, "");
	if (host === "localhost" || host.endsWith(".localhost"))
		throw new Error("unreachable GitHub webhook origin");
	const parts = host.split(".");
	if (parts.length === 4 && parts.every((part) => /^\d+$/.test(part))) {
		const [a, b] = parts.map(Number);
		if (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 100 && b !== undefined && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b !== undefined && b >= 16 && b <= 31) ||
			(a === 192 && b === 168)
		)
			throw new Error("unreachable GitHub webhook origin");
	}
	if (host.startsWith("[") && host.endsWith("]")) {
		const address = host.slice(1, -1);
		const first = Number.parseInt(address.split(":")[0] ?? "0", 16);
		if (
			address.startsWith("::") ||
			(first & 0xfe00) === 0xfc00 ||
			(first & 0xffc0) === 0xfe80 ||
			(first & 0xff00) === 0xff00
		)
			throw new Error("unreachable GitHub webhook origin");
	}
	return normalized;
}

/** Parse repository-local data. It never reads secrets or changes a relay. */
export function parseCiProjectConfig(
	json: string,
	organization?: CiProjectConfig,
): CiProjectConfig {
	try {
		if (
			json.length > 256 * 1024 ||
			new TextEncoder().encode(json).byteLength > 256 * 1024
		)
			throw new Error("project configuration too large");
		if (organization && !validatedConfigs.has(organization))
			throw new Error("organization configuration is not validated");
		const authored = CiProjectDocumentSchema.parse(
			parseBudgetPolicyDocumentJson(json),
		);
		if (findRawSecrets(authored.integrations ?? []).length)
			throw new Error("integrations must hold references, never secrets");
		const { selection: _ignoredSelection, ...documentBody } = authored;
		const input = ProjectInput.parse(resolveCiProjectReferences(documentBody));
		const entries = Object.entries(input.environments ?? {});
		const environments = Object.fromEntries(
			entries.map(([name, rawEntry]) => {
				const { extends: templateName, ...overrides } = rawEntry;
				if (templateName && !Object.hasOwn(input.templates ?? {}, templateName))
					throw new Error("unknown environment template");
				const template = templateName ? input.templates?.[templateName] : {};
				const entry = EnvironmentFields.parse(
					mergeTemplate(JsonValue.parse(template), JsonValue.parse(overrides)),
				);
				const allowInsecureLoopback = entry.allowInsecureLoopback ?? false;
				return [
					name,
					Object.freeze({
						name,
						relayOrigin: relayOrigin(entry.relayOrigin, allowInsecureLoopback),
						githubWebhookOrigin: entry.githubWebhookOrigin
							? githubWebhookOrigin(entry.githubWebhookOrigin)
							: undefined,
						allowInsecureLoopback,
						jobAdmission: entry.jobAdmission,
						store: entry.store ? Object.freeze({ ...entry.store }) : undefined,
						engines: parseEnvironmentEngineList(entry.engines),
						engineRelays: parseEnvironmentEngineRelays(entry.engineRelays),
						secrets: Object.freeze(
							Object.fromEntries(
								Object.entries(entry.secrets ?? {}).map(
									([key, requirement]) => [
										key,
										Object.freeze({
											requiredFor: Object.freeze([...requirement.requiredFor]),
										}),
									],
								),
							),
						),
						policy: parseCiPolicy(JSON.stringify(entry.policy)),
					}),
				];
			}),
		);
		const defaultEnvironment =
			input.defaultEnvironment ?? organization?.defaultEnvironment;
		if (!defaultEnvironment) throw new Error("default environment required");
		return projectConfig(defaultEnvironment, {
			...organization?.environments,
			...environments,
		});
	} catch {
		// Repository input can contain arbitrary text. Never put it in an error.
		throw new Error("invalid CI project configuration");
	}
}

/** Author the same repository configuration from the SDK. */
export function defineCiProjectConfig(
	input: CiProjectConfigInput,
	organization?: CiProjectConfig,
): CiProjectConfig {
	try {
		// `defineCiPolicy` returns frozen protobuf messages whose `$typeName`
		// metadata is not part of the authored JSON schema. Providers are
		// written as protobuf JSON so an unset `capacity` oneof or an empty
		// `location` never reach the closed authored provider shapes.
		return parseCiProjectConfig(
			JSON.stringify(input, (key, value) => {
				if (key === "budgetPolicy" && value !== undefined)
					parseBudgetPolicyJson(JSON.stringify(value));
				if (key === "$typeName") return undefined;
				if (!ProtobufPolicyProvider.safeParse(value).success) return value;
				const { location, ...provider } = JsonObject.parse(
					toJson(CiPolicyProviderSchema, value, { alwaysEmitImplicit: true }),
				);
				return location ? { ...provider, location } : provider;
			}),
			organization,
		);
	} catch {
		throw new Error("invalid CI project configuration");
	}
}

/** Select a named profile; process environment is never consulted implicitly. */
export function selectCiEnvironment(
	config: CiProjectConfig,
	environment?: string,
): CiProjectEnvironment {
	if (!validatedConfigs.has(config))
		throw new Error("CI project configuration has not been validated");
	const name = environment ?? config.defaultEnvironment;
	if (!environmentName.test(name) || !Object.hasOwn(config.environments, name))
		throw new Error("unknown CI environment");
	const selected = config.environments[name];
	if (!selected) throw new Error("unknown CI environment");
	return selected;
}

/** Return the declared logical names for an explicitly selected environment and phase. */
export function requiredCiSecrets(
	config: CiProjectConfig,
	environment: string,
	phase: CiSecretPhase,
): readonly string[] {
	if (!ExplicitEnvironment.safeParse(environment).success)
		throw new Error("explicit CI environment required");
	if (phase !== "deployment" && phase !== "execution")
		throw new Error("invalid CI secret phase");
	const selected = selectCiEnvironment(config, environment);
	return Object.freeze(
		Object.entries(selected.secrets)
			.filter(([, requirement]) => requirement.requiredFor.includes(phase))
			.map(([name]) => name)
			.sort(),
	);
}

export interface CiEnvironmentCredentialScope {
	readonly environment: string;
	readonly origin: string;
	readonly accountId: string;
}

export interface ConfiguredCiRelayOptions {
	/** Trusted environment, canonical origin and account bindings from outside the repo. */
	trustedTargets: readonly CiEnvironmentCredentialScope[];
	accountToken: (
		scope: CiEnvironmentCredentialScope,
	) => string | Promise<string>;
	fetch?: typeof fetch;
}

export interface CiPolicyApplyOptions extends ConfiguredCiRelayOptions {
	/** Digest from a trusted source independent of repository-controlled files. */
	expectedPolicySha256: string;
}

/** Hash normalized protobuf JSON for review and out-of-band policy pinning. */
export async function ciEnvironmentPolicySha256(
	config: CiProjectConfig,
	environment: string,
): Promise<string> {
	if (!ExplicitEnvironment.safeParse(environment).success)
		throw new Error("explicit CI environment required");
	const selected = selectCiEnvironment(config, environment);
	const policy = JsonObject.parse(
		JSON.parse(toJsonString(DesiredCiPolicySchema, selected.policy)),
	);
	if (selected.policy.budgetPolicy)
		policy.budgetPolicy = JsonValue.parse(
			JSON.parse(ciBudgetPolicyJson(selected.policy.budgetPolicy)),
		);
	const bytes = new TextEncoder().encode(JSON.stringify(policy));
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Digest an environment's secret names and lifecycle requirements, not their values. */
export async function ciEnvironmentSecretsSha256(
	config: CiProjectConfig,
	environment: string,
): Promise<string> {
	if (!ExplicitEnvironment.safeParse(environment).success)
		throw new Error("explicit CI environment required");
	const selected = selectCiEnvironment(config, environment);
	const declarations = Object.entries(selected.secrets)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([name, requirement]) => [name, [...requirement.requiredFor].sort()]);
	const payload = JSON.stringify({
		environment: selected.name,
		origin: selected.relayOrigin,
		accountId: selected.policy.accountId,
		secrets: declarations,
	});
	const digest = await globalThis.crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(payload),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Pin the endpoint before looking up or transmitting an account credential. */
export function createConfiguredCiRelayClient(
	config: CiProjectConfig,
	environment: string,
	options: ConfiguredCiRelayOptions,
) {
	if (!ExplicitEnvironment.safeParse(environment).success)
		throw new Error("explicit CI environment required");
	const selected = selectCiEnvironment(config, environment);
	const scope = Object.freeze({
		environment: selected.name,
		origin: selected.relayOrigin,
		accountId: selected.policy.accountId,
	});
	if (
		!options.trustedTargets.some(
			(target) =>
				target.environment === scope.environment &&
				target.origin === scope.origin &&
				target.accountId === scope.accountId,
		)
	)
		throw new Error("CI relay environment binding is not trusted");
	return createCiRelayClient({
		origin: selected.relayOrigin,
		allowInsecureLoopback: selected.allowInsecureLoopback,
		accountToken: () => options.accountToken(scope),
		fetch: options.fetch ?? fetch,
	});
}

/** Apply only on an explicit call, after verifying account identity and revision. */
export async function applyCiEnvironmentPolicy(
	config: CiProjectConfig,
	environment: string,
	options: CiPolicyApplyOptions,
) {
	const selected = selectCiEnvironment(config, environment);
	if (
		!/^[a-f0-9]{64}$/.test(options.expectedPolicySha256) ||
		(await ciEnvironmentPolicySha256(config, environment)) !==
			options.expectedPolicySha256
	)
		throw new Error("CI policy does not match trusted digest");
	const client = createConfiguredCiRelayClient(config, environment, options);
	const current = await client.getPolicy();
	if (current.account?.id !== selected.policy.accountId)
		throw new Error("CI relay account does not match selected policy");
	// The parsed policy is a frozen protobuf message. The client accepts authored
	// protobuf JSON, so remove message metadata through the protobuf serializer.
	const policy = JSON.parse(
		toJsonString(DesiredCiPolicySchema, selected.policy),
	);
	return client.putDesiredPolicy(policy, { revision: current.revision });
}

/**
 * Read the runner-provider integrations from `.hobo/ci.json` text. Entries are
 * references only; a credential-shaped value anywhere rejects the whole block
 * with an error that never contains repository text.
 */
export function parseCiRunnerIntegrations(
	json: string,
): readonly RunnerIntegration[] {
	try {
		const document = z
			.object({ integrations: z.json().optional() })
			.loose()
			.parse(JSON.parse(json));
		const raw = document.integrations ?? [];
		if (findRawSecrets(raw).length)
			throw new Error("integrations must hold references, never secrets");
		return Object.freeze(RunnerIntegrationsSchema.parse(raw));
	} catch {
		throw new Error(
			"invalid CI runner integrations (references only; see hobo ci connect --help)",
		);
	}
}
