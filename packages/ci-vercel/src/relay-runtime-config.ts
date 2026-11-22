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

import { readFileSync } from "node:fs";
import {
	createInfisicalClient,
	type InfisicalClient,
	infisicalBindingFromEnv,
	type JwtSource,
	oidcAuth,
	type ParsedInfisicalBinding,
	parseInfisicalBinding,
} from "@hobo/adapter-infisical";
import { getVercelOidcToken } from "@vercel/oidc";
import { z } from "zod";
import { withDerivedRelayKeys } from "./relay-derived-keys.js";
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
	// The session key, the Sandbox proxy token key and CRON_SECRET are derived
	// from the App private key unless the store holds them
	// (relay-derived-keys.ts).
	const parsed = RelayRuntimeConfigSchema.safeParse(
		withDerivedRelayKeys(present),
	);
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

// public-contract: the committed store coordinates the production relay reads (ids only).
export const COMMITTED_STORE_BINDING_URL = new URL(
	"../deploy/secret-store.binding.json",
	import.meta.url,
);

// The fields of `SecretStoreBinding` (@hobo/secret-store-claim) the relay
// reads; the record's own parser runs when it is written.
const CommittedBindingSchema = z
	.object({
		kind: z.string(),
		endpoint: z.string(),
		projectId: z.string(),
		environment: z.string(),
		secretPath: z.string(),
		relayIdentityId: z.string(),
	})
	.passthrough();

/** Where the production relay signs in, from the committed binding. */
export type CommittedStoreCoordinates = Readonly<{
	binding: ParsedInfisicalBinding;
	identityId: string;
}>;

/**
 * The committed `deploy/secret-store.binding.json` (the `SecretStoreBinding`
 * record of `@hobo/secret-store-claim`; coordinates only), as the relay needs
 * it: the store's origin, the relay's project, environment and folder, and
 * the relay's identity. Parsed by the adapter's own binding parser, so a
 * malformed file is refused by name, never quoted. Undefined when the file is
 * absent or names a store the relay cannot read.
 */
export function parseCommittedStoreCoordinates(
	text: string,
): CommittedStoreCoordinates | undefined {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		throw new RelayRuntimeConfigError("invalid committed store binding");
	}
	const record = CommittedBindingSchema.safeParse(json);
	if (!record.success)
		throw new RelayRuntimeConfigError("invalid committed store binding", [
			"deploy/secret-store.binding.json",
		]);
	if (
		record.data.kind !== "infisical-cloud-attach" &&
		record.data.kind !== "infisical-self-hosted"
	)
		return undefined;
	try {
		const binding = parseInfisicalBinding({
			siteUrl: record.data.endpoint,
			projectId: record.data.projectId,
			environment: record.data.environment,
			secretPath: record.data.secretPath,
		});
		const identityId = record.data.relayIdentityId;
		// Validated by the same parser OIDC Auth uses; throws on a bad id.
		oidcAuth({ identityId, jwt: vercelOidcJwtSource });
		return Object.freeze({ binding, identityId });
	} catch {
		throw new RelayRuntimeConfigError("invalid committed store binding", [
			"deploy/secret-store.binding.json",
		]);
	}
}

function readCommittedStoreCoordinates():
	| CommittedStoreCoordinates
	| undefined {
	let text: string;
	try {
		text = readFileSync(COMMITTED_STORE_BINDING_URL, "utf8");
	} catch {
		return undefined;
	}
	return parseCommittedStoreCoordinates(text);
}

/**
 * The source a deployment declares. `HOBO_CI_CONFIG_SERVICE=infisical` reads
 * the binding (`INFISICAL_SITE_URL`, `INFISICAL_IDENTITY_ID`,
 * `INFISICAL_PROJECT_ID`, `INFISICAL_ENVIRONMENT`, `INFISICAL_SECRET_PATH`:
 * plain configuration, not secrets) and signs in with `jwt`, the Vercel OIDC
 * token by default. `env` reads the environment.
 *
 * Unset: a production deployment (`VERCEL_ENV=production`) reads the
 * committed `deploy/secret-store.binding.json` bundled with the function
 * (ADR-0179 amendment "Secretless first"), so the Vercel Git integration's
 * build needs no environment variable set through Vercel's API; anything
 * else reads the environment.
 */
export function relayConfigSourceFromEnv(
	env: Readonly<Record<string, string | undefined>>,
	options: Readonly<{
		jwt?: JwtSource;
		fetch?: typeof fetch;
		/** The committed coordinates; read from the bundled file when absent. */
		committed?: () => CommittedStoreCoordinates | undefined;
	}> = {},
): RelayConfigSource {
	const declared = env.HOBO_CI_CONFIG_SERVICE;
	if (declared === undefined && env.VERCEL_ENV === "production") {
		const committed = (options.committed ?? readCommittedStoreCoordinates)();
		if (committed !== undefined) {
			const auth = oidcAuth({
				identityId: committed.identityId,
				jwt: options.jwt ?? vercelOidcJwtSource,
			});
			return infisicalRelayConfigSource(
				options.fetch === undefined
					? createInfisicalClient({ binding: committed.binding, auth })
					: createInfisicalClient({
							binding: committed.binding,
							auth,
							fetch: options.fetch,
						}),
			);
		}
	}
	const service = declared ?? "env";
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
