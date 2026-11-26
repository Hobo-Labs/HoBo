/**
 * Optional residual OpenBao SecretsPort (ADR-0113 / ADR-0027).
 * Not part of default @hobo/identity installs — opt-in package only.
 */

import { createHash, createHmac } from "node:crypto";
import type {
	FetchLike,
	SecretsAccessResult,
	SecretsPort,
} from "@hobo/identity";
import {
	isJsonString,
	type JsonBag,
	type JsonObject,
	type StringBag,
} from "./json.js";

/**
 * OpenBao residual secrets adapter.
 *
 * Auth: short-lived SVID JWT only (auth/jwt login). Never store a long-lived
 * OpenBao/Vault token. Offline mode: deterministic HMAC, network-free.
 */
/** The port's denied answer, as a transport failure produces it. */
type TransportDenial = Extract<SecretsAccessResult, { status: "denied" }>;

export function createOpenBaoSecretsPort(options: {
	readonly openbaoAddr: string;
	readonly role: string;
	readonly svidJwt: string;
	readonly mountPath?: string;
	readonly namespace?: string;
	readonly fetch?: FetchLike;
	readonly id?: string;
	/**
	 * When true, never call the network (deterministic HMAC).
	 * Defaults to true when `fetch` is omitted.
	 */
	readonly offline?: boolean;
}): SecretsPort {
	const addr = options.openbaoAddr.replace(/\/$/, "");
	const mount = options.mountPath ?? "secret";
	const offline =
		options.offline === true ||
		(options.offline !== false && options.fetch === undefined);
	const root = createHash("sha256")
		.update(
			`openbao:${addr}:${options.role}:${options.svidJwt}:${mount}:${options.namespace ?? ""}`,
		)
		.digest();
	const store = new Map<string, { versions: string[]; seeds: string[] }>();

	type TokenCache = { token: string; expiresAtMs: number };
	let tokenCache: TokenCache | null = null;

	function valueRef(name: string, versionId: string): string {
		const ns = options.namespace ? `${options.namespace}/` : "";
		return `openbao://${addr}/${ns}${mount}/${name}@${versionId}`;
	}

	function offlineMaterial(
		name: string,
		versionId: string,
		seed: string,
	): string {
		return createHmac("sha256", root)
			.update(`${name}:${versionId}:${seed}`)
			.digest("base64url");
	}

	function offlineAccess(
		name: string,
		versionId?: string,
	): SecretsAccessResult {
		const entry = store.get(name);
		if (versionId !== undefined) {
			const idx = entry?.versions.indexOf(versionId) ?? -1;
			// `seeds` is parallel to `versions`; if that invariant ever breaks,
			// derive the seed rather than hand back `undefined` as a string.
			const seed =
				(idx >= 0 ? entry?.seeds[idx] : undefined) ??
				createHmac("sha256", root).update(`${name}:${versionId}`).digest("hex");
			const material = offlineMaterial(name, versionId, seed);
			return {
				status: "ok",
				valueRef: valueRef(name, versionId),
				material,
				versionId,
				source: "provider-federation",
				expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
			};
		}
		const seed =
			entry?.seeds[entry.seeds.length - 1] ??
			createHmac("sha256", root).update(name).digest("base64url");
		const vid = entry?.versions[entry.versions.length - 1] ?? "ob-dynamic";
		const material = offlineMaterial(name, vid, seed);
		return {
			status: "ok",
			valueRef: valueRef(name, vid),
			material,
			versionId: vid,
			source: "provider-federation",
			expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
		};
	}

	function nsHeaders(extra?: StringBag): StringBag {
		return {
			"Content-Type": "application/json",
			...(options.namespace
				? { "X-Vault-Namespace": options.namespace }
				: undefined),
			...extra,
		};
	}

	/**
	 * A transport failure is a denial, not an escape. `fetch` rejecting — DNS,
	 * refused connection, timeout — and `res.json()` throwing on a truncated
	 * body were the only live failure modes that left the port's ok/denied
	 * answer shape: an unreachable OpenBao took the caller down with a
	 * TypeError above whatever policy was waiting for the denial, and it is
	 * also the likeliest live failure in production. Every reachable-server
	 * case already failed closed (no fetch, auth rejected, missing token,
	 * non-2xx); this closes the unreachable-server case the same way. The
	 * reason carries the transport error's own message — an address or errno,
	 * never secret material — so "server down" stays distinguishable from
	 * "wrong port" at the call site.
	 */
	function transportDenied(stage: string, cause: unknown): TransportDenial {
		return {
			status: "denied",
			reason: `openbao ${stage} transport failed: ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
			code: "openbao-transport-failed",
		};
	}

	async function jwtLogin(): Promise<
		| { status: "ok"; token: string; leaseDurationSec: number }
		| { status: "denied"; reason: string; code: string }
	> {
		if (!options.fetch) {
			return {
				status: "denied",
				reason: "openbao live path requires injected fetch",
				code: "openbao-no-fetch",
			};
		}
		const now = Date.now();
		if (tokenCache && tokenCache.expiresAtMs > now + 5_000) {
			return {
				status: "ok",
				token: tokenCache.token,
				leaseDurationSec: Math.max(
					0,
					Math.floor((tokenCache.expiresAtMs - now) / 1000),
				),
			};
		}
		let res: Awaited<ReturnType<FetchLike>>;
		try {
			res = await options.fetch(`${addr}/v1/auth/jwt/login`, {
				method: "POST",
				headers: nsHeaders(),
				body: JSON.stringify({
					role: options.role,
					jwt: options.svidJwt,
				}),
			});
		} catch (error) {
			return transportDenied("jwt login", error);
		}
		if (!res.ok) {
			return {
				status: "denied",
				reason: `openbao jwt login http ${res.status}`,
				code: "openbao-auth-failed",
			};
		}
		let data: { auth?: { client_token?: string; lease_duration?: number } };
		try {
			// SAFETY: OpenBao's login body is parsed at this secrets-port boundary.
			data = (await res.json()) as {
				auth?: { client_token?: string; lease_duration?: number };
			};
		} catch (error) {
			return transportDenied("jwt login", error);
		}
		const token = data.auth?.client_token;
		if (!token) {
			return {
				status: "denied",
				reason: "openbao jwt login missing client_token",
				code: "openbao-auth-missing-token",
			};
		}
		const lease = Math.max(1, data.auth?.lease_duration ?? 900);
		tokenCache = { token, expiresAtMs: now + lease * 1000 };
		return { status: "ok", token, leaseDurationSec: lease };
	}

	async function liveGet(
		name: string,
		versionId?: string,
	): Promise<SecretsAccessResult> {
		const login = await jwtLogin();
		if (login.status === "denied") {
			return {
				status: "denied",
				reason: login.reason,
				code: login.code,
			};
		}
		if (!options.fetch) {
			return {
				status: "denied",
				reason: "openbao live path requires injected fetch",
				code: "openbao-no-fetch",
			};
		}
		const q =
			versionId !== undefined
				? `?version=${encodeURIComponent(versionId)}`
				: "";
		const path = `${addr}/v1/${mount}/data/${name.replace(/^\//, "")}${q}`;
		let res: Awaited<ReturnType<FetchLike>>;
		try {
			res = await options.fetch(path, {
				method: "GET",
				headers: nsHeaders({ "X-Vault-Token": login.token }),
			});
		} catch (error) {
			return transportDenied("kv get", error);
		}
		if (!res.ok) {
			return {
				status: "denied",
				reason: `openbao kv get http ${res.status}`,
				code:
					res.status === 404
						? "openbao-secret-not-found"
						: "openbao-kv-http-error",
			};
		}
		// SAFETY: assertion to `wait res.json()) as { data?: { data?: { value?: string; [k: string]: unknown }; metadata?: { version?: number }; lease_d` is required at this boundary.
		interface OpenBaoKvBody {
			data?: {
				data?: JsonBag;
				metadata?: { version?: number };
				lease_duration?: number;
			};
			lease_duration?: number;
		}
		let parsed: unknown;
		try {
			parsed = await res.json();
		} catch (error) {
			return transportDenied("kv get", error);
		}
		// SAFETY: OpenBao KV JSON body is parsed at this secrets-port boundary.
		const data = parsed as OpenBaoKvBody;
		const body = data.data?.data;
		const material = isJsonString(body?.value)
			? body.value
			: body !== undefined
				? JSON.stringify(body)
				: undefined;
		const metaVersion = data.data?.metadata?.version;
		const vid =
			versionId ??
			(metaVersion !== undefined ? `obv${metaVersion}` : "ob-current");
		const leaseSec =
			data.lease_duration ??
			data.data?.lease_duration ??
			login.leaseDurationSec ??
			900;
		if (material === undefined) {
			return {
				status: "denied",
				reason: `openbao secret ${name} empty`,
				code: "openbao-secret-empty",
			};
		}
		return {
			status: "ok",
			valueRef: valueRef(name, vid),
			material,
			versionId: vid,
			source: "provider-federation",
			expiresAt: new Date(Date.now() + leaseSec * 1000).toISOString(),
		};
	}

	async function livePut(
		name: string,
		value: string,
	): Promise<
		{ versionId: string } | { status: "denied"; reason: string; code: string }
	> {
		const login = await jwtLogin();
		if (login.status === "denied") {
			return login;
		}
		if (!options.fetch) {
			return {
				status: "denied",
				reason: "openbao live path requires injected fetch",
				code: "openbao-no-fetch",
			};
		}
		const path = `${addr}/v1/${mount}/data/${name.replace(/^\//, "")}`;
		let res: Awaited<ReturnType<FetchLike>>;
		try {
			res = await options.fetch(path, {
				method: "POST",
				headers: nsHeaders({ "X-Vault-Token": login.token }),
				body: JSON.stringify({ data: { value } }),
			});
		} catch (error) {
			return transportDenied("kv put", error);
		}
		if (!res.ok) {
			return {
				status: "denied",
				reason: `openbao kv put http ${res.status}`,
				code: "openbao-kv-put-http-error",
			};
		}
		let data: { data?: { version?: number } };
		try {
			// SAFETY: OpenBao's KV write body is parsed at this secrets-port boundary.
			data = (await res.json()) as { data?: { version?: number } };
		} catch (error) {
			return transportDenied("kv put", error);
		}
		const versionId =
			data.data?.version !== undefined
				? `obv${data.data.version}`
				: `obv-${createHash("sha256").update(value).digest("hex").slice(0, 8)}`;
		return { versionId };
	}

	async function liveListVersions(
		name: string,
	): Promise<readonly string[] | null> {
		if (!options.fetch) return null;
		const login = await jwtLogin();
		if (login.status === "denied") return null;
		const path = `${addr}/v1/${mount}/metadata/${name.replace(/^\//, "")}`;
		let data: { data?: { versions?: JsonObject } };
		try {
			const res = await options.fetch(path, {
				method: "GET",
				headers: nsHeaders({ "X-Vault-Token": login.token }),
			});
			if (!res.ok) return null;
			// SAFETY: OpenBao's KV metadata body is parsed at this boundary.
			data = (await res.json()) as { data?: { versions?: JsonObject } };
		} catch {
			// null is this helper's failure shape: version listing is advisory,
			// and an unreachable server means "no versions known", not a crash.
			return null;
		}
		const versions = data.data?.versions;
		if (!versions) return null;
		return Object.freeze(
			Object.keys(versions)
				.map((k) => `obv${k}`)
				.sort(),
		);
	}

	return {
		id: options.id ?? `secrets:openbao:${options.role}`,
		kind: "openbao",
		async put(name, value) {
			if (!offline) {
				const live = await livePut(name, value);
				if (!("status" in live)) {
					const entry = store.get(name) ?? { versions: [], seeds: [] };
					entry.versions.push(live.versionId);
					entry.seeds.push(value);
					store.set(name, entry);
					return { versionId: live.versionId };
				}
			}
			const entry = store.get(name) ?? { versions: [], seeds: [] };
			const versionId = `obv${entry.versions.length + 1}`;
			entry.versions.push(versionId);
			entry.seeds.push(value);
			store.set(name, entry);
			return { versionId };
		},
		async access(name) {
			if (!offline) {
				return liveGet(name);
			}
			return offlineAccess(name);
		},
		async accessVersion(name, versionId) {
			if (!offline) {
				return liveGet(name, versionId);
			}
			return offlineAccess(name, versionId);
		},
		async listVersions(name) {
			if (!offline) {
				const live = await liveListVersions(name);
				if (live && live.length > 0) return live;
			}
			return Object.freeze([...(store.get(name)?.versions ?? ["ob-dynamic"])]);
		},
	};
}

/**
 * Local Station residual OpenBao helper (opt-in package).
 * Offline unless HOBO_OPENBAO_LIVE=1 and fetch is available.
 */
export function createLocalStationOpenBaoSecretsPort(options?: {
	readonly stationId?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly fetch?: FetchLike;
	readonly id?: string;
	readonly offline?: boolean;
}): SecretsPort {
	const env = options?.env ?? process.env;
	const stationId = options?.stationId ?? env.HOBO_STATION_ID ?? "local";
	const svidJwt =
		(isJsonString(env.HOBO_SVID_JWT) && env.HOBO_SVID_JWT) ||
		`eyJhbGciOiJFUzI1NiJ9.station.${stationId}.fixture`;
	const live =
		options?.offline === true
			? false
			: env.HOBO_OPENBAO_LIVE === "1" || env.HOBO_OPENBAO_LIVE === "true";
	const liveFetch = globalThis.fetch;
	// SAFETY: global fetch is the OpenBao transport at this residual port.
	const globalFetch: FetchLike | undefined = live
		? (liveFetch as FetchLike | undefined)
		: undefined;
	const fetchImpl = options?.fetch ?? globalFetch;
	const openbaoAddr =
		(isJsonString(env.HOBO_OPENBAO_ADDR) && env.HOBO_OPENBAO_ADDR) ||
		(isJsonString(env.OPENBAO_ADDR) && env.OPENBAO_ADDR) ||
		"http://127.0.0.1:8200";
	const role =
		(isJsonString(env.HOBO_OPENBAO_ROLE) && env.HOBO_OPENBAO_ROLE) ||
		`hobo-station-${stationId}`;
	const namespace =
		isJsonString(env.HOBO_OPENBAO_NAMESPACE) && env.HOBO_OPENBAO_NAMESPACE
			? env.HOBO_OPENBAO_NAMESPACE
			: undefined;
	const mountPath =
		isJsonString(env.HOBO_OPENBAO_MOUNT) && env.HOBO_OPENBAO_MOUNT
			? env.HOBO_OPENBAO_MOUNT
			: undefined;

	return createOpenBaoSecretsPort({
		openbaoAddr,
		role,
		svidJwt,
		offline: !live || fetchImpl === undefined,
		id: options?.id ?? `secrets:station-openbao:${stationId}`,
		...(namespace !== undefined ? { namespace } : undefined),
		...(mountPath !== undefined ? { mountPath } : undefined),
		...(fetchImpl !== undefined ? { fetch: fetchImpl } : undefined),
	});
}
