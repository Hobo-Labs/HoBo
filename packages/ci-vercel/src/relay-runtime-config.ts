/**
 * The hosted relay's runtime configuration, loaded from the config service
 * (ADR-0179, phase 3). Not wired into `entry.ts` yet: a later phase does that.
 *
 * - `infisical`: the relay signs in to Infisical with its Vercel OIDC token
 *   (OIDC Auth, no secret zero) and lists one folder: the config document
 *   (`HOBO_CI_CONFIG_JSON`) and every secret arrive in one request.
 * - `env`: the same keys from the process environment, for local runs and
 *   tests. Both give the same `RelayRuntimeConfig`.
 *
 * Parse, don't validate: the entries cross `parseRelayRuntimeConfig` once and
 * become the derived `RelayRuntimeConfig`; the loader keeps it in memory for a
 * TTL, and a failed refresh keeps the last good copy.
 */

import {
	createInfisicalClient,
	type InfisicalClient,
	infisicalBindingFromEnv,
	type JwtSource,
	oidcAuth,
} from "@hobo/adapter-infisical";
import { getVercelOidcToken } from "@vercel/oidc";
import type { z } from "zod";
import {
	RELAY_RUNTIME_CONFIG_KEYS,
	RelayRuntimeConfigSchema,
} from "./relay-runtime-config-schema.js";

declare const relayConfigBrand: unique symbol;

// domain-view: the parsed, branded form of RelayRuntimeConfig in
// data-models/relay_runtime_config.proto, keyed by its JSON names (the
// environment variable names the relay's composition reads).
export type RelayRuntimeConfig = Readonly<
	z.infer<typeof RelayRuntimeConfigSchema>
> & { readonly [relayConfigBrand]: "RelayRuntimeConfig" };

/** Raised when entries do not form a valid configuration. Names keys, never values. */
export class RelayRuntimeConfigError extends Error {
	readonly keys: readonly string[];
	constructor(message: string, keys: readonly string[] = []) {
		super(keys.length ? `${message}: ${keys.join(", ")}` : message);
		this.name = "RelayRuntimeConfigError";
		this.keys = Object.freeze([...keys]);
	}
}

const KNOWN = new Set(RELAY_RUNTIME_CONFIG_KEYS);

export function parseRelayRuntimeConfig(
	entries: Readonly<Record<string, string>>,
): RelayRuntimeConfig {
	// An empty entry reads as unset, as an empty environment variable does.
	const present = Object.fromEntries(
		Object.entries(entries).filter(([, value]) => value !== ""),
	);
	const unknown = Object.keys(present).filter((key) => !KNOWN.has(key));
	if (unknown.length)
		throw new RelayRuntimeConfigError(
			"the config service holds entries the relay does not use",
			unknown.sort(),
		);
	const parsed = RelayRuntimeConfigSchema.safeParse(present);
	if (!parsed.success) {
		// Zod's issues can quote input; report the keys only.
		const keys = [
			...new Set(
				parsed.error.issues.map((issue) =>
					issue.path.length ? String(issue.path[0]) : "(document)",
				),
			),
		].sort();
		throw new RelayRuntimeConfigError("invalid relay configuration", keys);
	}
	// SAFETY: the schema above accepted exactly these entries.
	return Object.freeze(parsed.data) as RelayRuntimeConfig;
}

/** Where the relay's entries come from. `read` returns every entry, values included. */
export type RelayConfigSource = Readonly<{
	kind: "infisical" | "env";
	read(): Promise<Readonly<Record<string, string>>>;
}>;

/** The relay's keys from an environment; everything else in it is ignored. */
export function envRelayConfigSource(
	env: Readonly<Record<string, string | undefined>>,
): RelayConfigSource {
	return Object.freeze({
		kind: "env",
		async read() {
			const entries: Record<string, string> = {};
			for (const key of RELAY_RUNTIME_CONFIG_KEYS) {
				const value = env[key];
				if (value !== undefined) entries[key] = value;
			}
			return entries;
		},
	});
}

/** Every entry of the bound Infisical folder, in one request. */
export function infisicalRelayConfigSource(
	client: InfisicalClient,
): RelayConfigSource {
	return Object.freeze({
		kind: "infisical",
		async read() {
			const entries: Record<string, string> = {};
			for (const secret of await client.listSecrets())
				entries[secret.secretKey] = secret.value;
			return entries;
		},
	});
}

/**
 * The relay's Vercel OIDC token. Vercel delivers it per request (the
 * `x-vercel-oidc-token` header) and says not to cache it, so this must run
 * inside a request: https://vercel.com/docs/oidc/reference
 */
export const vercelOidcJwtSource: JwtSource = () => getVercelOidcToken();

/**
 * The source a deployment declares. `HOBO_CI_CONFIG_SERVICE=infisical` reads
 * the binding (`INFISICAL_SITE_URL`, `INFISICAL_IDENTITY_ID`,
 * `INFISICAL_PROJECT_ID`, `INFISICAL_ENVIRONMENT`, `INFISICAL_SECRET_PATH`:
 * plain configuration, not secrets) and signs in with `jwt`, the Vercel OIDC
 * token by default. Unset or `env` reads the environment.
 */
export function relayConfigSourceFromEnv(
	env: Readonly<Record<string, string | undefined>>,
	options: Readonly<{ jwt?: JwtSource; fetch?: typeof fetch }> = {},
): RelayConfigSource {
	const service = env.HOBO_CI_CONFIG_SERVICE ?? "env";
	if (service === "env") return envRelayConfigSource(env);
	if (service !== "infisical")
		throw new RelayRuntimeConfigError("unknown config service", [
			"HOBO_CI_CONFIG_SERVICE",
		]);
	const binding = infisicalBindingFromEnv(env);
	const auth = oidcAuth({
		identityId: env.INFISICAL_IDENTITY_ID,
		jwt: options.jwt ?? vercelOidcJwtSource,
	});
	return infisicalRelayConfigSource(
		options.fetch === undefined
			? createInfisicalClient({ binding, auth })
			: createInfisicalClient({ binding, auth, fetch: options.fetch }),
	);
}

export type RelayRuntimeConfigLoader = Readonly<{
	/** The configuration, read at most once per TTL. */
	load(): Promise<RelayRuntimeConfig>;
	/** Forget the cached copy; the next load reads the source. */
	invalidate(): void;
}>;

/**
 * Reads once, then at most once per `ttlMs` (default a minute). Concurrent
 * loads share one read. A refresh that fails keeps the last good copy and
 * calls `onRefreshFailed` (with the error, which names keys or an Infisical
 * code, never a value); with no good copy yet, the load fails.
 */
export function createRelayRuntimeConfigLoader(
	options: Readonly<{
		source: RelayConfigSource;
		ttlMs?: number;
		now?: () => number;
		onRefreshFailed?: (error: Error) => void;
	}>,
): RelayRuntimeConfigLoader {
	const ttlMs = options.ttlMs ?? 60_000;
	const now = options.now ?? Date.now;
	let cached: { config: RelayRuntimeConfig; readAt: number } | undefined;
	let pending: Promise<RelayRuntimeConfig> | undefined;

	async function refresh(): Promise<RelayRuntimeConfig> {
		const readAt = now();
		try {
			const config = parseRelayRuntimeConfig(await options.source.read());
			cached = { config, readAt };
			return config;
		} catch (error) {
			if (!cached) throw error;
			options.onRefreshFailed?.(
				error instanceof Error
					? error
					: new RelayRuntimeConfigError("config refresh failed"),
			);
			// Retry after another TTL, not on every request.
			cached = { config: cached.config, readAt };
			return cached.config;
		}
	}

	return Object.freeze({
		async load() {
			if (cached && now() - cached.readAt < ttlMs) return cached.config;
			pending ??= refresh().finally(() => {
				pending = undefined;
			});
			return pending;
		},
		invalidate() {
			cached = undefined;
		},
	});
}
