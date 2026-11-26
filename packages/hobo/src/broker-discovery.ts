/**
 * Broker discovery document — mandatory before remote/anonymous deploy.
 * Parse-don't-validate: invalid payloads fail closed.
 */

import {
	cloneAsJson,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

export type BrokerAuthMethod =
	| "svid"
	| "oidc"
	| "dpop"
	| "anonymous"
	| "bearer";

// public-contract: discovery document schema id.
export const BROKER_DISCOVERY_SCHEMA = "hobo.broker-discovery/v1" as const;

export interface BrokerDiscoveryDocument {
	readonly schemaVersion: typeof BROKER_DISCOVERY_SCHEMA;
	readonly brokerId: string;
	readonly issuer: string;
	readonly authMethods: readonly BrokerAuthMethod[];
	readonly supportsAnonymous: boolean;
	readonly claimEndpoint: string;
	readonly placeEndpoint: string;
	readonly anonymousSessionEndpoint: string;
	readonly ttlHintSeconds?: number;
	readonly restrictions?: readonly string[];
	readonly resourceMetadataUrl?: string;
}

export interface BrokerDiscoveryClient {
	discover(brokerUri: string): Promise<BrokerDiscoveryDocument>;
}

export function parseBrokerDiscoveryDocument(
	raw: JsonValue | undefined,
): BrokerDiscoveryDocument {
	if (raw === null || !isJsonObject(raw)) {
		throw new BrokerDiscoveryError(
			"discovery document must be a JSON object",
			"HOBO_DISCOVERY_INVALID",
		);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const obj = raw as JsonObject;
	if (obj.schemaVersion !== BROKER_DISCOVERY_SCHEMA) {
		throw new BrokerDiscoveryError(
			`discovery schemaVersion must be ${BROKER_DISCOVERY_SCHEMA}`,
			"HOBO_DISCOVERY_INVALID",
		);
	}
	const brokerId = requireString(obj.brokerId, "brokerId");
	const issuer = requireString(obj.issuer, "issuer");
	const claimEndpoint = requireString(obj.claimEndpoint, "claimEndpoint");
	const placeEndpoint = requireString(obj.placeEndpoint, "placeEndpoint");
	const anonymousSessionEndpoint = requireString(
		obj.anonymousSessionEndpoint,
		"anonymousSessionEndpoint",
	);
	if (!Array.isArray(obj.authMethods) || obj.authMethods.length === 0) {
		throw new BrokerDiscoveryError(
			"discovery.authMethods must be a non-empty array",
			"HOBO_DISCOVERY_INVALID",
		);
	}
	const authMethods = obj.authMethods.map((m, i) => {
		if (
			m !== "svid" &&
			m !== "oidc" &&
			m !== "dpop" &&
			m !== "anonymous" &&
			m !== "bearer"
		) {
			throw new BrokerDiscoveryError(
				`discovery.authMethods[${i}] unsupported: ${String(m)}`,
				"HOBO_DISCOVERY_INVALID",
			);
		}
		// SAFETY: assertion required at this I/O or test boundary.
		return m as BrokerAuthMethod;
	});
	const supportsAnonymous =
		obj.supportsAnonymous === true || authMethods.includes("anonymous");
	if (!isJsonBoolean(obj.supportsAnonymous)) {
		// If omitted, derive from authMethods only when anonymous is listed.
		// Explicit false must be respected when present.
	}
	const explicitAnon = isJsonBoolean(obj.supportsAnonymous)
		? obj.supportsAnonymous
		: supportsAnonymous;

	return {
		schemaVersion: BROKER_DISCOVERY_SCHEMA,
		brokerId,
		issuer,
		authMethods,
		supportsAnonymous: explicitAnon,
		claimEndpoint,
		placeEndpoint,
		anonymousSessionEndpoint,
		...(isJsonNumber(obj.ttlHintSeconds) && Number.isFinite(obj.ttlHintSeconds)
			? { ttlHintSeconds: obj.ttlHintSeconds }
			: undefined),
		...(Array.isArray(obj.restrictions)
			? {
					restrictions: obj.restrictions.filter((r): r is string =>
						isJsonString(r),
					),
				}
			: undefined),
		...(isJsonString(obj.resourceMetadataUrl)
			? { resourceMetadataUrl: obj.resourceMetadataUrl }
			: undefined),
	};
}

export class BrokerDiscoveryError extends Error {
	readonly code: string;
	constructor(message: string, code: string) {
		super(message);
		this.name = "BrokerDiscoveryError";
		this.code = code;
	}
}

function requireString(value: JsonValue | undefined, field: string): string {
	if (!isJsonString(value) || value.trim().length === 0) {
		throw new BrokerDiscoveryError(
			`discovery.${field} must be a non-empty string`,
			"HOBO_DISCOVERY_INVALID",
		);
	}
	return value.trim();
}

/**
 * Fetch discovery from well-known paths under the broker URI.
 * HONEST SCOPE: production brokers may serve protected-resource metadata;
 * this client tries the HoBo well-known first, then /.well-known/oauth-protected-resource.
 */
export function createBrokerDiscoveryClient(options?: {
	readonly fetchImpl?: typeof fetch;
	/** Inject a fixed document (tests / in-process mock broker). */
	readonly fixed?: ReadonlyMap<string, BrokerDiscoveryDocument | unknown>;
}): BrokerDiscoveryClient {
	const fetchImpl = options?.fetchImpl ?? fetch;
	return {
		async discover(brokerUri: string) {
			const base = brokerUri.replace(/\/+$/, "");
			if (options?.fixed?.has(base)) {
				return parseBrokerDiscoveryDocument(
					cloneAsJson(options.fixed.get(base)),
				);
			}
			const candidates = [
				`${base}/.well-known/hobo-broker`,
				`${base}/.well-known/oauth-protected-resource`,
				`${base}/discovery`,
			];
			const errors: string[] = [];
			for (const url of candidates) {
				try {
					const res = await fetchImpl(url, {
						headers: { accept: "application/json" },
					});
					if (!res.ok) {
						errors.push(`${url} → HTTP ${res.status}`);
						continue;
					}
					const body = await res.json();
					// Protected-resource metadata may wrap our document.
					const parsedBody = isJsonObject(body) ? body : {};
					const nested = parsedBody.hobo_broker;
					const candidate =
						"schemaVersion" in parsedBody
							? parsedBody
							: isJsonObject(nested)
								? nested
								: parsedBody;
					return parseBrokerDiscoveryDocument(candidate);
				} catch (error) {
					errors.push(
						`${url}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			throw new BrokerDiscoveryError(
				`broker discovery failed for ${base}: ${errors.join("; ")}`,
				"HOBO_DISCOVERY_UNREACHABLE",
			);
		},
	};
}

export function defaultMockDiscovery(
	brokerUri: string,
	overrides: Partial<BrokerDiscoveryDocument> = {},
): BrokerDiscoveryDocument {
	const base = brokerUri.replace(/\/+$/, "");
	return {
		schemaVersion: BROKER_DISCOVERY_SCHEMA,
		brokerId: `broker:${new URL(base).host}`,
		issuer: base,
		authMethods: ["svid", "oidc", "dpop", "anonymous"],
		supportsAnonymous: true,
		claimEndpoint: `${base}/v1/claim`,
		placeEndpoint: `${base}/v1/place`,
		anonymousSessionEndpoint: `${base}/v1/anonymous-session`,
		ttlHintSeconds: 3600,
		restrictions: ["no-custom-domains", "ephemeral-only"],
		...overrides,
	};
}
