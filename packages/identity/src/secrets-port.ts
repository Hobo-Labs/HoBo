/**
 * hobo:secrets residual port (ADR-0113) + resolution ladder (ADR-0027).
 * Preferred paths: bound-resource / provider-federation. Static hatch is last.
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import { must } from "@hobo/core/total-access";
import type { SecretSourceRank } from "./config-types.js";
import { isJsonString, type JsonValue } from "./json.js";

export type SecretsAccessResult =
	| Readonly<{
			status: "ok";
			/** Opaque reference or redacted placeholder — never log this as a secret in production paths that leave the broker. */
			valueRef: string;
			/** Short-lived material for mediated use only. */
			material?: string;
			versionId?: string;
			source: SecretSourceRank;
			expiresAt?: string;
	  }>
	| Readonly<{ status: "denied"; reason: string; code: string }>;

/**
 * Residual managed-secrets store (ADR-0113). Prefer identity federation.
 * `openbao` kind is reserved for the optional `@hobo/adapter-openbao` package
 * (not shipped with default identity installs); `opensesame` for the optional
 * `@hobo/adapter-opensesame` package, whose `access` returns the run's `osr_`
 * surrogate (never the credential it stands for) and whose `put` is read-only
 * (ADR-0170); `infisical` for the optional `@hobo/adapter-infisical` package,
 * which signs in with a workload OIDC token (no secret zero) and reads the
 * hosted CI relay's config and secrets (ADR-0179).
 */
export interface SecretsPort {
	readonly id: string;
	readonly kind:
		| "vault-jwt"
		| "openbao"
		| "opensesame"
		| "infisical"
		| "aws-sm"
		| "azure-kv"
		| "memory-fixture";
	put(name: string, value: string): Promise<{ versionId: string }>;
	access(name: string): Promise<SecretsAccessResult>;
	accessVersion(name: string, versionId: string): Promise<SecretsAccessResult>;
	listVersions(name: string): Promise<readonly string[]>;
}

/** In-memory fixture store for tests / hobo dev (contract-asserted). */
export function createMemorySecretsPort(options?: {
	readonly id?: string;
}): SecretsPort & {
	/** Test-only: inspect without returning raw values in events. */
	readonly names: () => readonly string[];
} {
	const store = new Map<string, { versions: string[]; values: string[] }>();
	return {
		id: options?.id ?? "secrets:memory",
		kind: "memory-fixture",
		async put(name, value) {
			const entry = store.get(name) ?? { versions: [], values: [] };
			const versionId = `v${entry.versions.length + 1}-${createHash("sha256").update(value).digest("hex").slice(0, 8)}`;
			entry.versions.push(versionId);
			entry.values.push(value);
			store.set(name, entry);
			return { versionId };
		},
		async access(name) {
			const entry = store.get(name);
			if (!entry || entry.values.length === 0) {
				return {
					status: "denied",
					reason: `secret ${name} not found`,
					code: "secret-not-found",
				};
			}
			const idx = entry.values.length - 1;
			return {
				status: "ok",
				valueRef: `secref://${name}/${entry.versions[idx]}`,
				material: entry.values[idx],
				versionId: entry.versions[idx],
				source: "provider-federation",
			};
		},
		async accessVersion(name, versionId) {
			const entry = store.get(name);
			if (!entry) {
				return {
					status: "denied",
					reason: `secret ${name} not found`,
					code: "secret-not-found",
				};
			}
			const idx = entry.versions.indexOf(versionId);
			if (idx < 0) {
				return {
					status: "denied",
					reason: `version ${versionId} not found`,
					code: "secret-version-not-found",
				};
			}
			return {
				status: "ok",
				valueRef: `secref://${name}/${versionId}`,
				material: entry.values[idx],
				versionId,
				source: "provider-federation",
			};
		},
		async listVersions(name) {
			return Object.freeze([...(store.get(name)?.versions ?? [])]);
		},
		names: () => Object.freeze([...store.keys()]),
	};
}

/**
 * Vault adapter that authenticates via JWT/OIDC (SVID) — no static Vault token.
 * Offline/stub mode mints deterministic material from the JWT subject.
 */
export function createVaultJwtSecretsPort(options: {
	readonly vaultAddr: string;
	readonly role: string;
	/** Minted SVID JWT for Vault login (never a static vault token). */
	readonly svidJwt: string;
	readonly id?: string;
}): SecretsPort {
	const root = createHash("sha256")
		.update(`vault-jwt:${options.vaultAddr}:${options.role}:${options.svidJwt}`)
		.digest();
	const store = new Map<string, { versions: string[]; seeds: string[] }>();

	return {
		id: options.id ?? `secrets:vault-jwt:${options.role}`,
		kind: "vault-jwt",
		async put(name, value) {
			const entry = store.get(name) ?? { versions: [], seeds: [] };
			const versionId = `vv${entry.versions.length + 1}`;
			entry.versions.push(versionId);
			entry.seeds.push(value);
			store.set(name, entry);
			return { versionId };
		},
		async access(name) {
			const entry = store.get(name);
			const seed =
				entry?.seeds[entry.seeds.length - 1] ??
				createHmac("sha256", root).update(name).digest("base64url");
			const versionId =
				entry?.versions[entry.versions.length - 1] ?? "vv-dynamic";
			const material = createHmac("sha256", root)
				.update(`${name}:${versionId}:${seed}`)
				.digest("base64url");
			return {
				status: "ok",
				valueRef: `vault://${options.vaultAddr}/secret/${name}@${versionId}`,
				material,
				versionId,
				source: "provider-federation",
				expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
			};
		},
		async accessVersion(name, versionId) {
			const entry = store.get(name);
			const idx = entry?.versions.indexOf(versionId) ?? -1;
			const seed =
				idx >= 0 && entry
					? must(entry.seeds[idx], "entry.seeds[idx]")
					: createHmac("sha256", root)
							.update(`${name}:${versionId}`)
							.digest("hex");
			const material = createHmac("sha256", root)
				.update(`${name}:${versionId}:${seed}`)
				.digest("base64url");
			return {
				status: "ok",
				valueRef: `vault://${options.vaultAddr}/secret/${name}@${versionId}`,
				material,
				versionId,
				source: "provider-federation",
				expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
			};
		},
		async listVersions(name) {
			return Object.freeze([...(store.get(name)?.versions ?? ["vv-dynamic"])]);
		},
	};
}

export type FetchLike = (
	input: string,
	init?: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
	},
) => Promise<{
	ok: boolean;
	status: number;
	json: () => Promise<JsonValue>;
	text: () => Promise<string>;
}>;

/**
 * AWS Secrets Manager adapter (Camp-scoped).
 * Uses brokered short-lived credentials via injected signer headers — never static long-lived keys in the adapter.
 * Offline mode (no fetch) falls back to deterministic HMAC material for local/dev parity.
 */
export function createAwsSecretsManagerPort(options?: {
	readonly region?: string;
	readonly endpoint?: string;
	/** Injected authenticated fetch (caller attaches SigV4 / brokered session). */
	readonly fetch?: FetchLike;
	/** Brokered bearer for local HTTP mock / gateway. */
	readonly accessToken?: string;
	readonly id?: string;
}): SecretsPort {
	const region = options?.region ?? "us-east-1";
	const endpoint =
		options?.endpoint ?? `https://secretsmanager.${region}.amazonaws.com`;
	const memory = createMemorySecretsPort({
		id: options?.id ?? `secrets:aws-sm:${region}`,
	});
	const root = createHash("sha256")
		.update(`aws-sm:${region}:${options?.accessToken ?? "offline"}`)
		.digest();

	async function liveAccess(
		name: string,
		versionId?: string,
	): Promise<SecretsAccessResult | null> {
		if (!options?.fetch) return null;
		const body = JSON.stringify({
			SecretId: name,
			...(versionId !== undefined ? { VersionId: versionId } : undefined),
		});
		const res = await options.fetch(endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-amz-json-1.1",
				"X-Amz-Target": versionId
					? "secretsmanager.GetSecretValue"
					: "secretsmanager.GetSecretValue",
				...(options.accessToken
					? { Authorization: `Bearer ${options.accessToken}` }
					: undefined),
			},
			body,
		});
		if (!res.ok) {
			return {
				status: "denied",
				reason: `aws-sm http ${res.status}`,
				code: "aws-sm-http-error",
			};
		}
		// SAFETY: assertion to ` res.json()) as { ARN?: string; VersionId?: string; SecretString?: string; }; co` is required at this boundary.
		const data = (await res.json()) as {
			ARN?: string;
			VersionId?: string;
			SecretString?: string;
		};
		const vid = data.VersionId ?? versionId ?? "AWSCURRENT";
		return {
			status: "ok",
			valueRef: `aws-sm://${region}/${name}@${vid}`,
			material: data.SecretString,
			versionId: vid,
			source: "provider-federation",
			expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
		};
	}

	return {
		id: memory.id,
		kind: "aws-sm",
		async put(name, value) {
			if (options?.fetch) {
				await options.fetch(endpoint, {
					method: "POST",
					headers: {
						"Content-Type": "application/x-amz-json-1.1",
						"X-Amz-Target": "secretsmanager.PutSecretValue",
						...(options.accessToken
							? { Authorization: `Bearer ${options.accessToken}` }
							: undefined),
					},
					body: JSON.stringify({ SecretId: name, SecretString: value }),
				});
			}
			return memory.put(name, value);
		},
		async access(name) {
			const live = await liveAccess(name);
			if (live) return live;
			const local = await memory.access(name);
			if (local.status === "ok") {
				return {
					...local,
					valueRef: `aws-sm://${region}/${name}@${local.versionId ?? "local"}`,
					source: "provider-federation",
				};
			}
			// Offline dynamic: deterministic material so mediation still works.
			const material = createHmac("sha256", root)
				.update(name)
				.digest("base64url");
			return {
				status: "ok",
				valueRef: `aws-sm://${region}/${name}@dynamic`,
				material,
				versionId: "dynamic",
				source: "provider-federation",
				expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
			};
		},
		async accessVersion(name, versionId) {
			const live = await liveAccess(name, versionId);
			if (live) return live;
			return memory.accessVersion(name, versionId);
		},
		async listVersions(name) {
			return memory.listVersions(name);
		},
	};
}

/** @deprecated Prefer createAwsSecretsManagerPort — alias for Camp adapter registry. */
export const createAwsSecretsManagerStub = createAwsSecretsManagerPort;

/**
 * Azure Key Vault adapter (Camp-scoped).
 * Authenticates via brokered OAuth token (SVID→federation), not a static vault key.
 */
export function createAzureKeyVaultPort(options?: {
	readonly vaultName?: string;
	readonly vaultUrl?: string;
	readonly fetch?: FetchLike;
	readonly accessToken?: string;
	readonly id?: string;
}): SecretsPort {
	const vaultName = options?.vaultName ?? "default";
	const vaultUrl = options?.vaultUrl ?? `https://${vaultName}.vault.azure.net`;
	const memory = createMemorySecretsPort({
		id: options?.id ?? `secrets:azure-kv:${vaultName}`,
	});
	const root = createHash("sha256")
		.update(`azure-kv:${vaultName}:${options?.accessToken ?? "offline"}`)
		.digest();

	async function liveGet(
		name: string,
		versionId?: string,
	): Promise<SecretsAccessResult | null> {
		if (!options?.fetch) return null;
		const path =
			versionId !== undefined
				? `${vaultUrl}/secrets/${encodeURIComponent(name)}/${encodeURIComponent(versionId)}?api-version=7.4`
				: `${vaultUrl}/secrets/${encodeURIComponent(name)}?api-version=7.4`;
		const res = await options.fetch(path, {
			method: "GET",
			headers: {
				...(options.accessToken
					? { Authorization: `Bearer ${options.accessToken}` }
					: undefined),
			},
		});
		if (!res.ok) {
			return {
				status: "denied",
				reason: `azure-kv http ${res.status}`,
				code: "azure-kv-http-error",
			};
		}
		// SAFETY: assertion to `.json()) as { id?: string; value?: string; attributes?: { exp?: number }; }; const ` is required at this boundary.
		const data = (await res.json()) as {
			id?: string;
			value?: string;
			attributes?: { exp?: number };
		};
		const vid = versionId ?? (data.id?.split("/").pop() || "current");
		return {
			status: "ok",
			valueRef: `azure-kv://${vaultName}/${name}@${vid}`,
			material: data.value,
			versionId: vid,
			source: "provider-federation",
			expiresAt: data.attributes?.exp
				? new Date(data.attributes.exp * 1000).toISOString()
				: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
		};
	}

	return {
		id: memory.id,
		kind: "azure-kv",
		async put(name, value) {
			if (options?.fetch) {
				await options.fetch(
					`${vaultUrl}/secrets/${encodeURIComponent(name)}?api-version=7.4`,
					{
						method: "PUT",
						headers: {
							"Content-Type": "application/json",
							...(options.accessToken
								? { Authorization: `Bearer ${options.accessToken}` }
								: undefined),
						},
						body: JSON.stringify({ value }),
					},
				);
			}
			return memory.put(name, value);
		},
		async access(name) {
			const live = await liveGet(name);
			if (live) return live;
			const local = await memory.access(name);
			if (local.status === "ok") {
				return {
					...local,
					valueRef: `azure-kv://${vaultName}/${name}@${local.versionId ?? "local"}`,
					source: "provider-federation",
				};
			}
			const material = createHmac("sha256", root)
				.update(name)
				.digest("base64url");
			return {
				status: "ok",
				valueRef: `azure-kv://${vaultName}/${name}@dynamic`,
				material,
				versionId: "dynamic",
				source: "provider-federation",
				expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
			};
		},
		async accessVersion(name, versionId) {
			const live = await liveGet(name, versionId);
			if (live) return live;
			return memory.accessVersion(name, versionId);
		},
		async listVersions(name) {
			return memory.listVersions(name);
		},
	};
}

/** @deprecated Prefer createAzureKeyVaultPort. */
export const createAzureKeyVaultStub = createAzureKeyVaultPort;

/**
 * Local Station residual secrets (wasm / local Camp host).
 *
 * **Default backend is memory** — no optional OpenBao dependency in default
 * installs. For residual OpenBao, install `@hobo/adapter-openbao` and use
 * `createOpenBaoSecretsPort` / `createLocalStationOpenBaoSecretsPort`.
 *
 * `HOBO_LOCAL_SECRETS_BACKEND=memory` (default) | `vault-jwt`
 */
export function createLocalStationSecretsPort(options?: {
	readonly stationId?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly fetch?: FetchLike;
	readonly id?: string;
	/** Unused; retained for API stability. OpenBao lives in @hobo/adapter-openbao. */
	readonly offline?: boolean;
}): SecretsPort {
	const env = options?.env ?? process.env;
	const backend = (env.HOBO_LOCAL_SECRETS_BACKEND ?? "memory").toLowerCase();
	const stationId = options?.stationId ?? env.HOBO_STATION_ID ?? "local";
	const svidJwt =
		(isJsonString(env.HOBO_SVID_JWT) && env.HOBO_SVID_JWT) ||
		`eyJhbGciOiJFUzI1NiJ9.station.${stationId}.fixture`;

	if (backend === "vault-jwt") {
		return createVaultJwtSecretsPort({
			vaultAddr:
				(isJsonString(env.HOBO_VAULT_ADDR) && env.HOBO_VAULT_ADDR) ||
				"https://vault.local",
			role:
				(isJsonString(env.HOBO_VAULT_ROLE) && env.HOBO_VAULT_ROLE) ||
				`hobo-station-${stationId}`,
			svidJwt,
			id: options?.id ?? `secrets:station-vault:${stationId}`,
		});
	}
	if (backend === "openbao") {
		throw new Error(
			"OpenBao residual secrets require optional package @hobo/adapter-openbao " +
				"(not included in default installs). " +
				'import { createLocalStationOpenBaoSecretsPort } from "@hobo/adapter-openbao" ' +
				"or set HOBO_LOCAL_SECRETS_BACKEND=memory|vault-jwt",
		);
	}
	// default memory
	return createMemorySecretsPort({
		id: options?.id ?? `secrets:station-memory:${stationId}`,
	});
}

/**
 * Camp-scoped secrets port factory — Bindle declares need; Camp selects backend.
 * OpenBao is not a built-in case — use `@hobo/adapter-openbao` explicitly.
 */
export function createCampSecretsPort(input: {
	readonly backend: "memory" | "vault-jwt" | "aws-sm" | "azure-kv";
	readonly vaultAddr?: string;
	readonly vaultRole?: string;
	readonly svidJwt?: string;
	readonly region?: string;
	readonly vaultName?: string;
	readonly fetch?: FetchLike;
	readonly accessToken?: string;
}): SecretsPort {
	switch (input.backend) {
		case "memory":
			return createMemorySecretsPort();
		case "vault-jwt":
			return createVaultJwtSecretsPort({
				vaultAddr: input.vaultAddr ?? "https://vault.local",
				role: input.vaultRole ?? "hobo-workload",
				svidJwt: input.svidJwt ?? "eyJhbGciOiJFUzI1NiJ9.svid.fixture",
			});
		case "aws-sm":
			return createAwsSecretsManagerPort({
				region: input.region,
				...(input.fetch !== undefined ? { fetch: input.fetch } : undefined),
				...(input.accessToken !== undefined
					? { accessToken: input.accessToken }
					: undefined),
			});
		case "azure-kv":
			return createAzureKeyVaultPort({
				vaultName: input.vaultName,
				...(input.fetch !== undefined ? { fetch: input.fetch } : undefined),
				...(input.accessToken !== undefined
					? { accessToken: input.accessToken }
					: undefined),
			});
		default: {
			const _exhaustive: never = input.backend;
			throw new Error(`unknown secrets backend: ${_exhaustive}`);
		}
	}
}

export interface HoboSecretsStore {
	put: (name: string, value: Uint8Array) => Promise<string>;
	access: (name: string) => Promise<{ versionId: string; value: Uint8Array }>;
	accessVersion: (name: string, versionId: string) => Promise<Uint8Array>;
	listVersions: (name: string) => Promise<readonly string[]>;
}

/**
 * WIT-shaped hobo:secrets@0.1.0 store view over a SecretsPort (ADR-0113).
 * Residual managed-store surface only — not the preferred credential path.
 */
export function asHoboSecretsStore(port: SecretsPort): HoboSecretsStore {
	return {
		async put(name, value) {
			const { versionId } = await port.put(
				name,
				Buffer.from(value).toString("utf8"),
			);
			return versionId;
		},
		async access(name) {
			const r = await port.access(name);
			if (r.status !== "ok" || r.material === undefined || !r.versionId) {
				throw new Error(r.status === "denied" ? r.reason : "access failed");
			}
			return {
				versionId: r.versionId,
				value: new Uint8Array(Buffer.from(r.material, "utf8")),
			};
		},
		async accessVersion(name, versionId) {
			const r = await port.accessVersion(name, versionId);
			if (r.status !== "ok" || r.material === undefined) {
				throw new Error(r.status === "denied" ? r.reason : "access failed");
			}
			return new Uint8Array(Buffer.from(r.material, "utf8"));
		},
		async listVersions(name) {
			return port.listVersions(name);
		},
	};
}

export type ConfigSensitivity = "public" | "internal" | "sensitive";

export type ResolvedConfigEntry = Readonly<{
	name: string;
	source: SecretSourceRank;
	/** Non-secret values only; secrets use placeholder. */
	value?: unknown;
	valueRef?: string;
	versionId?: string;
	sensitive: boolean;
	/** ADR-0142 classification. */
	sensitivity: ConfigSensitivity;
	/** Agent-safe placeholder when sensitive. */
	placeholder: string;
}>;

function sensitivityOf(sensitive: boolean): ConfigSensitivity {
	return sensitive ? "sensitive" : "public";
}

export type ResolutionLadderInput = Readonly<{
	name: string;
	sensitive: boolean;
	preferredSource: SecretSourceRank;
	/** Allowed ranks from policy (deny-ceiling). */
	allowedSources: readonly SecretSourceRank[];
	/** Bound resource token path (no secret). */
	boundToken?: () => Promise<string | undefined>;
	/** Camp non-secret value. */
	campValue?: unknown;
	/** Secrets port for federation / static hatch. */
	secretsPort?: SecretsPort;
	/** Static hatch material (only when preferredSource is static-escape). */
	staticMaterial?: string;
	now?: string;
}>;

/**
 * Ranked resolution ladder (ADR-0027). Never returns plaintext for sensitive
 * fields into agent-facing structures (placeholder + valueRef only).
 */
export async function resolveConfigEntry(
	input: ResolutionLadderInput,
): Promise<
	| Readonly<{ status: "resolved"; entry: ResolvedConfigEntry }>
	| Readonly<{ status: "denied"; reason: string; code: string }>
> {
	const ranks: SecretSourceRank[] = [
		"bound-resource",
		"provider-federation",
		"camp-value",
		"static-escape",
	];
	// Try from preferred down the ladder, but only allowed ranks.
	const start = ranks.indexOf(input.preferredSource);
	const order = [
		...ranks.slice(Math.max(0, start)),
		...ranks.slice(0, Math.max(0, start)),
	].filter((r) => input.allowedSources.includes(r));

	for (const source of order) {
		if (source === "bound-resource" && input.boundToken) {
			const token = await input.boundToken();
			if (token) {
				return {
					status: "resolved",
					entry: {
						name: input.name,
						source,
						sensitive: input.sensitive,
						sensitivity: sensitivityOf(input.sensitive),
						valueRef: `tokenref://bound/${input.name}`,
						placeholder: input.sensitive
							? `[REDACTED:bound-resource:${input.name}]`
							: String(token),
						...(input.sensitive ? undefined : { value: token }),
					},
				};
			}
		}
		if (source === "provider-federation" && input.secretsPort) {
			const accessed = await input.secretsPort.access(input.name);
			if (accessed.status === "ok") {
				return {
					status: "resolved",
					entry: {
						name: input.name,
						source,
						sensitive: true,
						sensitivity: "sensitive",
						valueRef: accessed.valueRef,
						versionId: accessed.versionId,
						placeholder: `[REDACTED:provider-federation:${input.name}]`,
						// material stays broker-internal — not on agent-facing entry
					},
				};
			}
		}
		if (source === "camp-value" && input.campValue !== undefined) {
			if (input.sensitive) {
				// Sensitive must not come from camp-value.
				continue;
			}
			return {
				status: "resolved",
				entry: {
					name: input.name,
					source,
					sensitive: false,
					sensitivity: "public",
					value: input.campValue,
					valueRef: `camp://${input.name}`,
					placeholder: String(input.campValue),
				},
			};
		}
		if (
			source === "static-escape" &&
			input.preferredSource === "static-escape" &&
			input.staticMaterial
		) {
			const versionId = `static-${randomUUID().slice(0, 8)}`;
			return {
				status: "resolved",
				entry: {
					name: input.name,
					source,
					sensitive: true,
					sensitivity: "sensitive",
					valueRef: `staticref://${input.name}/${versionId}`,
					versionId,
					placeholder: `[REDACTED:static-escape:${input.name}]`,
				},
			};
		}
	}

	return {
		status: "denied",
		reason: `no resolution path for ${input.name}`,
		code: "config-unresolved",
	};
}
