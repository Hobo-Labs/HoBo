/**
 * Thin remote broker client over discovery + place/claim/anonymous-session.
 *
 * HONEST SCOPE: live multi-broker production transport is mock-capable. The
 * in-memory mock implements faithful shapes; HTTP path uses fetch against
 * discovery endpoints. Real hosted brokers plug in without changing CLI control flow.
 */

import type { PrincipalRef } from "@hobo/core";
import { mustGet } from "@hobo/core/total-access";
import {
	type BrokerDiscoveryClient,
	type BrokerDiscoveryDocument,
	createBrokerDiscoveryClient,
	defaultMockDiscovery,
	parseBrokerDiscoveryDocument,
} from "./broker-discovery.js";
import {
	authorizationHeaders,
	type PresentedCredential,
} from "./credential-presenter.js";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

export interface AnonymousSessionResult {
	readonly ephemeralPrincipal: PrincipalRef;
	readonly accessToken: string;
	readonly claimToken: string;
	readonly claimUrl: string;
	readonly primaryUrl: string;
	readonly expiresAt: string;
	readonly ttlSeconds: number;
	readonly deploymentId: string;
	readonly restrictions: readonly string[];
}

export interface RemotePlaceRequest {
	readonly bindleName: string;
	readonly projectDir: string;
	readonly camp?: string | null;
	readonly credential: PresentedCredential;
	readonly anonymous?: boolean;
	readonly claimToken?: string;
}

export interface RemotePlaceResult {
	readonly deploymentId: string;
	readonly primaryUrl: string;
	readonly status: string;
	readonly brokerId: string;
	readonly resources: Readonly<Record<string, string>>;
	readonly claimToken?: string;
	readonly claimUrl?: string;
	readonly expiresAt?: string;
	readonly ttlSeconds?: number;
	readonly principal: PrincipalRef;
	readonly humanPrincipal?: PrincipalRef;
	readonly credentialScheme: string;
}

export interface RemoteClaimRequest {
	readonly claimToken: string;
	readonly account: string;
	readonly credential?: PresentedCredential;
}

export interface RemoteClaimResult {
	readonly deploymentId: string;
	readonly owner: PrincipalRef;
	readonly previousOwner: PrincipalRef | null;
	readonly primaryUrl: string;
	readonly status: string;
	readonly resources: Readonly<Record<string, string>>;
	readonly alreadyClaimed: boolean;
}

export interface RemoteBrokerClient {
	discover(): Promise<BrokerDiscoveryDocument>;
	createAnonymousSession(input?: {
		readonly bindleName?: string;
	}): Promise<AnonymousSessionResult>;
	place(request: RemotePlaceRequest): Promise<RemotePlaceResult>;
	claim(request: RemoteClaimRequest): Promise<RemoteClaimResult>;
	readonly brokerUri: string;
}

interface HttpHeaders {
	[header: string]: string;
}

interface StringBag {
	[key: string]: string;
}

export class RemoteBrokerClientError extends Error {
	readonly code: string;
	readonly data?: JsonObject;
	constructor(message: string, code: string, data?: JsonObject) {
		super(message);
		this.name = "RemoteBrokerClientError";
		this.code = code;
		if (data !== undefined) this.data = data;
	}
}

export function createRemoteBrokerClient(options: {
	readonly brokerUri: string;
	readonly discovery?: BrokerDiscoveryClient;
	readonly fetchImpl?: typeof fetch;
	/**
	 * In-process mock store. When set, no network is used for place/claim/session.
	 * HONEST SCOPE for live remote lane when mock is injected in tests.
	 */
	readonly mock?: MockRemoteBrokerState;
}): RemoteBrokerClient {
	const brokerUri = options.brokerUri.replace(/\/+$/, "");
	const discovery =
		options.discovery ??
		createBrokerDiscoveryClient({
			...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : undefined),
			...(options.mock
				? {
						fixed: new Map([[brokerUri, options.mock.discovery]]),
					}
				: undefined),
		});
	const fetchImpl = options.fetchImpl ?? fetch;
	let cachedDiscovery: BrokerDiscoveryDocument | null = null;

	async function getDiscovery(): Promise<BrokerDiscoveryDocument> {
		if (cachedDiscovery) return cachedDiscovery;
		cachedDiscovery = await discovery.discover(brokerUri);
		return cachedDiscovery;
	}

	function resolveUrl(endpoint: string, anonymousSession = false): string {
		const base = new URL(brokerUri);
		const resolved = new URL(endpoint, `${brokerUri}/`);
		if (
			(resolved.origin !== base.origin &&
				!(anonymousSession && resolved.protocol === "https:")) ||
			resolved.username !== "" ||
			resolved.password !== ""
		) {
			throw new RemoteBrokerClientError(
				"broker discovery endpoint must remain on the selected broker origin and contain no user information",
				"HOBO_BROKER_ENDPOINT_UNSAFE",
			);
		}
		return resolved.toString();
	}

	return {
		brokerUri,
		async discover() {
			return getDiscovery();
		},
		async createAnonymousSession(input = {}) {
			const doc = await getDiscovery();
			if (!doc.supportsAnonymous) {
				throw new RemoteBrokerClientError(
					"broker does not advertise anonymous support",
					"HOBO_ANON_NOT_SUPPORTED",
					{ brokerId: doc.brokerId },
				);
			}
			if (options.mock) {
				return options.mock.createAnonymousSession(input.bindleName);
			}
			const res = await fetchImpl(
				resolveUrl(doc.anonymousSessionEndpoint, true),
				{
					method: "POST",
					redirect: "error",
					headers: {
						"content-type": "application/json",
						accept: "application/json",
					},
					body: JSON.stringify({
						bindleName: input.bindleName ?? "unknown",
					}),
				},
			);
			if (!res.ok) {
				throw new RemoteBrokerClientError(
					`anonymous session failed (HTTP ${res.status})`,
					"HOBO_ANON_SESSION_FAILED",
				);
			}
			return parseAnonymousSession(await res.json());
		},
		async place(request) {
			const doc = await getDiscovery();
			if (options.mock) {
				return options.mock.place(request, doc);
			}
			const headers = {
				"content-type": "application/json",
				accept: "application/json",
				...authorizationHeaders(request.credential),
			};
			const res = await fetchImpl(resolveUrl(doc.placeEndpoint), {
				method: "POST",
				redirect: "error",
				headers,
				body: JSON.stringify({
					bindleName: request.bindleName,
					projectDir: request.projectDir,
					camp: request.camp ?? null,
					anonymous: request.anonymous === true,
					claimToken: request.claimToken,
				}),
			});
			if (!res.ok) {
				// SAFETY: assertion required at this I/O or test boundary.
				const body = (await res.json().catch(() => ({}))) as JsonObject;
				throw new RemoteBrokerClientError(
					isJsonString(body.message)
						? body.message
						: `remote place failed (HTTP ${res.status})`,
					"HOBO_REMOTE_PLACE_FAILED",
					body,
				);
			}
			return parsePlaceResult(await res.json(), request.credential);
		},
		async claim(request) {
			const doc = await getDiscovery();
			if (options.mock) {
				return options.mock.claim(request);
			}
			const headers: HttpHeaders = {
				"content-type": "application/json",
				accept: "application/json",
			};
			if (request.credential) {
				Object.assign(headers, authorizationHeaders(request.credential));
			}
			const res = await fetchImpl(resolveUrl(doc.claimEndpoint), {
				method: "POST",
				redirect: "error",
				headers,
				body: JSON.stringify({
					claimToken: request.claimToken,
					account: request.account,
				}),
			});
			if (!res.ok) {
				// SAFETY: assertion required at this I/O or test boundary.
				const body = (await res.json().catch(() => ({}))) as JsonObject;
				const code = isJsonString(body.code)
					? body.code
					: res.status === 401 || res.status === 403
						? "HOBO_CLAIM_TOKEN_INVALID"
						: "HOBO_REMOTE_CLAIM_FAILED";
				throw new RemoteBrokerClientError(
					isJsonString(body.message)
						? body.message
						: `remote claim failed (HTTP ${res.status})`,
					code,
					body,
				);
			}
			return parseClaimResult(await res.json());
		},
	};
}

export interface MockRemoteBrokerState {
	readonly discovery: BrokerDiscoveryDocument;
	createAnonymousSession(bindleName?: string): AnonymousSessionResult;
	place(
		request: RemotePlaceRequest,
		discovery: BrokerDiscoveryDocument,
	): RemotePlaceResult;
	claim(request: RemoteClaimRequest): RemoteClaimResult;
}

/**
 * Faithful in-process mock for control-flow tests (anonymous → claim preserves URL).
 */
export function createMockRemoteBrokerState(options?: {
	readonly brokerUri?: string;
	readonly supportsAnonymous?: boolean;
	readonly now?: () => number;
}): MockRemoteBrokerState {
	const brokerUri = (
		options?.brokerUri ?? "https://public.example.com"
	).replace(/\/+$/, "");
	const supportsAnonymous = options?.supportsAnonymous !== false;
	const now = options?.now ?? (() => Date.now());
	const deployments = new Map<
		string,
		{
			deploymentId: string;
			primaryUrl: string;
			resources: Record<string, string>;
			status: string;
			owner: PrincipalRef | null;
			claimToken: string;
			expiresAt: number;
			bindleName: string;
		}
	>();
	const tokens = new Map<string, string>(); // claimToken → deploymentId

	const discovery = defaultMockDiscovery(brokerUri, {
		supportsAnonymous,
		authMethods: supportsAnonymous
			? ["svid", "oidc", "dpop", "anonymous"]
			: ["svid", "oidc", "dpop"],
	});

	return {
		discovery,
		createAnonymousSession(bindleName = "app") {
			if (!supportsAnonymous) {
				throw new RemoteBrokerClientError(
					"broker does not advertise anonymous support",
					"HOBO_ANON_NOT_SUPPORTED",
				);
			}
			const deploymentId = `dep-anon-${Math.random().toString(36).slice(2, 10)}`;
			const claimToken = `claim_${deploymentId}_${Math.random().toString(36).slice(2, 10)}`;
			const ttlSeconds = discovery.ttlHintSeconds ?? 3600;
			const expiresAtMs = now() + ttlSeconds * 1000;
			const primaryUrl = `https://${deploymentId}.anon.hobo.example.com`;
			const ephemeralPrincipal: PrincipalRef = {
				kind: "user",
				id: `anonymous:${deploymentId}`,
			};
			const resources = {
				web: "provisioned",
				api: "provisioned",
			};
			deployments.set(deploymentId, {
				deploymentId,
				primaryUrl,
				resources,
				status: "deployed",
				owner: null,
				claimToken,
				expiresAt: expiresAtMs,
				bindleName,
			});
			tokens.set(claimToken, deploymentId);
			return {
				ephemeralPrincipal,
				accessToken: `anon-access-${deploymentId}`,
				claimToken,
				claimUrl: `${brokerUri}/claim?token=${encodeURIComponent(claimToken)}`,
				primaryUrl,
				expiresAt: new Date(expiresAtMs).toISOString(),
				ttlSeconds,
				deploymentId,
				restrictions: discovery.restrictions ?? [],
			};
		},
		place(request, doc) {
			if (request.anonymous && request.claimToken) {
				const deploymentId = tokens.get(request.claimToken);
				if (!deploymentId) {
					throw new RemoteBrokerClientError(
						"unknown claim token for anonymous place",
						"HOBO_CLAIM_TOKEN_INVALID",
					);
				}
				const dep = mustGet(deployments, deploymentId, "deployments");
				if (dep.expiresAt < now()) {
					throw new RemoteBrokerClientError(
						"anonymous claim token expired",
						"HOBO_CLAIM_TOKEN_EXPIRED",
					);
				}
				return {
					deploymentId: dep.deploymentId,
					primaryUrl: dep.primaryUrl,
					status: dep.status,
					brokerId: doc.brokerId,
					resources: dep.resources,
					claimToken: dep.claimToken,
					claimUrl: `${brokerUri}/claim?token=${encodeURIComponent(dep.claimToken)}`,
					expiresAt: new Date(dep.expiresAt).toISOString(),
					ttlSeconds: Math.max(0, Math.floor((dep.expiresAt - now()) / 1000)),
					principal: request.credential.principal,
					...(request.credential.humanPrincipal
						? { humanPrincipal: request.credential.humanPrincipal }
						: undefined),
					credentialScheme: request.credential.scheme,
				};
			}

			const deploymentId = `dep-auth-${Math.random().toString(36).slice(2, 10)}`;
			const primaryUrl = `https://${deploymentId}.broker.hobo.example.com`;
			const resources = { web: "provisioned", api: "provisioned" };
			deployments.set(deploymentId, {
				deploymentId,
				primaryUrl,
				resources,
				status: "deployed",
				owner: request.credential.principal,
				claimToken: "",
				expiresAt: now() + 86400_000,
				bindleName: request.bindleName,
			});
			return {
				deploymentId,
				primaryUrl,
				status: "deployed",
				brokerId: doc.brokerId,
				resources,
				principal: request.credential.principal,
				...(request.credential.humanPrincipal
					? { humanPrincipal: request.credential.humanPrincipal }
					: undefined),
				credentialScheme: request.credential.scheme,
			};
		},
		claim(request) {
			const deploymentId = tokens.get(request.claimToken);
			if (!deploymentId) {
				throw new RemoteBrokerClientError(
					"invalid claim token",
					"HOBO_CLAIM_TOKEN_INVALID",
				);
			}
			const dep = mustGet(deployments, deploymentId, "deployments");
			if (dep.expiresAt < now() && dep.owner === null) {
				throw new RemoteBrokerClientError(
					"claim token expired",
					"HOBO_CLAIM_TOKEN_EXPIRED",
				);
			}
			const newOwner: PrincipalRef = { kind: "user", id: request.account };
			if (dep.owner?.kind === newOwner.kind && dep.owner?.id === newOwner.id) {
				return {
					deploymentId: dep.deploymentId,
					owner: newOwner,
					previousOwner: dep.owner,
					primaryUrl: dep.primaryUrl,
					status: dep.status,
					resources: dep.resources,
					alreadyClaimed: true,
				};
			}
			const previousOwner = dep.owner;
			dep.owner = newOwner;
			// Preserve URL and resources — rebind only.
			return {
				deploymentId: dep.deploymentId,
				owner: newOwner,
				previousOwner,
				primaryUrl: dep.primaryUrl,
				status: dep.status,
				resources: { ...dep.resources },
				alreadyClaimed: false,
			};
		},
	};
}

function parseAnonymousSession(
	raw: JsonValue | undefined,
): AnonymousSessionResult {
	if (raw === null || !isJsonObject(raw)) {
		throw new RemoteBrokerClientError(
			"anonymous session payload invalid",
			"HOBO_ANON_SESSION_INVALID",
		);
	}
	const principal = principalFrom(raw.ephemeralPrincipal);
	if (principal === null) {
		throw new RemoteBrokerClientError(
			"anonymous session missing ephemeralPrincipal",
			"HOBO_ANON_SESSION_INVALID",
		);
	}
	return {
		ephemeralPrincipal: principal,
		accessToken: requireField(raw, "accessToken"),
		claimToken: requireField(raw, "claimToken"),
		claimUrl: requireField(raw, "claimUrl"),
		primaryUrl: requireField(raw, "primaryUrl"),
		expiresAt: requireField(raw, "expiresAt"),
		ttlSeconds: Number(raw.ttlSeconds ?? 3600),
		deploymentId: requireField(raw, "deploymentId"),
		restrictions: Array.isArray(raw.restrictions)
			? raw.restrictions.filter((r): r is string => isJsonString(r))
			: [],
	};
}

function parsePlaceResult(
	raw: JsonValue | undefined,
	credential: PresentedCredential,
): RemotePlaceResult {
	if (raw === null || !isJsonObject(raw)) {
		throw new RemoteBrokerClientError(
			"place payload invalid",
			"HOBO_REMOTE_PLACE_INVALID",
		);
	}
	const resources = stringBagFrom(raw.resources);
	return {
		deploymentId: requireField(raw, "deploymentId"),
		primaryUrl: requireField(raw, "primaryUrl"),
		status: isJsonString(raw.status) ? raw.status : "deployed",
		brokerId: requireField(raw, "brokerId"),
		resources,
		...(isJsonString(raw.claimToken)
			? { claimToken: raw.claimToken }
			: undefined),
		...(isJsonString(raw.claimUrl) ? { claimUrl: raw.claimUrl } : undefined),
		...(isJsonString(raw.expiresAt) ? { expiresAt: raw.expiresAt } : undefined),
		...(isJsonNumber(raw.ttlSeconds)
			? { ttlSeconds: raw.ttlSeconds }
			: undefined),
		principal: credential.principal,
		...(credential.humanPrincipal
			? { humanPrincipal: credential.humanPrincipal }
			: undefined),
		credentialScheme: credential.scheme,
	};
}

function parseClaimResult(raw: JsonValue | undefined): RemoteClaimResult {
	if (raw === null || !isJsonObject(raw)) {
		throw new RemoteBrokerClientError(
			"claim payload invalid",
			"HOBO_REMOTE_CLAIM_INVALID",
		);
	}
	const owner = principalFrom(raw.owner);
	if (owner === null) {
		throw new RemoteBrokerClientError(
			"claim payload missing owner",
			"HOBO_REMOTE_CLAIM_INVALID",
		);
	}
	return {
		deploymentId: requireField(raw, "deploymentId"),
		owner,
		previousOwner: principalFrom(raw.previousOwner),
		primaryUrl: requireField(raw, "primaryUrl"),
		status: isJsonString(raw.status) ? raw.status : "claimed",
		resources: stringBagFrom(raw.resources),
		alreadyClaimed: raw.alreadyClaimed === true,
	};
}

function stringBagFrom(value: JsonValue | undefined): StringBag {
	const bag: StringBag = {};
	if (!isJsonObject(value)) return bag;
	for (const [key, entry] of Object.entries(value)) {
		if (isJsonString(entry)) bag[key] = entry;
	}
	return bag;
}

function principalFrom(value: JsonValue | undefined): PrincipalRef | null {
	if (!isJsonObject(value)) return null;
	const id = value.id;
	const kind = value.kind;
	if (!isJsonString(id)) return null;
	switch (kind) {
		case "user":
		case "agent":
		case "service":
		case "system":
			return { id, kind };
		default:
			return null;
	}
}

function requireField(obj: JsonObject, field: string): string {
	const value = obj[field];
	if (!isJsonString(value) || value.length === 0) {
		throw new RemoteBrokerClientError(
			`missing field ${field}`,
			"HOBO_REMOTE_PAYLOAD_INVALID",
		);
	}
	return value;
}

// re-export parse for tests
export { parseBrokerDiscoveryDocument };
