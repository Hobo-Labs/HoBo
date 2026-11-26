/**
 * The Netlify REST operations this driver needs, and nothing else.
 *
 * There are only two, and both exist to answer questions the CLI cannot:
 * *did the site actually change hands*, and *is the site still there*. The
 * anonymous deploy itself never touches this client — it has no credential to
 * make an API call with, which is the whole point of that path.
 */
import type { SecretRef } from "@hobo/bindings";

import { resolveSecret, type SecretResolverPort } from "./custody.js";
import { isJsonObject, isJsonString, parseJsonValue } from "./json.js";
import {
	NetlifyProviderError,
	providerErrorForStatus,
} from "./provider-errors.js";
import {
	createGuardedTransport,
	DEFAULT_TRANSPORT_POLICY,
	type NetlifyTransport,
	type TransportPolicy,
} from "./transport.js";

// public-contract: documented Netlify management API endpoint.
export const NETLIFY_API_BASE = "https://api.netlify.com" as const;

export type NetlifySite = {
	readonly id: string;
	readonly name: string;
	/** The owning team. This is the ownership fact a claim has to move. */
	readonly accountId: string;
	readonly accountSlug?: string;
	readonly url?: string;
};

/**
 * What a credential can see.
 *
 * `forbidden` and `absent` are kept apart deliberately: after a claim, losing
 * *read* access is evidence the site moved, while the site being gone is
 * evidence the claim window closed and Netlify reaped it. Collapsing them would
 * report a reaped site as a successful hand-over.
 */
export type SiteAccess =
	| { readonly kind: "readable"; readonly site: NetlifySite }
	| { readonly kind: "forbidden" }
	| { readonly kind: "absent" };

export type NetlifyClientOptions = {
	readonly transport: NetlifyTransport;
	readonly resolver: SecretResolverPort;
	readonly policy?: TransportPolicy;
	readonly timeoutMs?: number;
	readonly maxResponseBytes?: number;
};

export type NetlifyClient = {
	/** `GET /api/v1/sites/{site_id}` with a caller-supplied token. */
	readSite(input: {
		readonly siteId: string;
		readonly tokenRef: SecretRef;
	}): Promise<NetlifySite>;
	/**
	 * The same read, with the two interesting failures modelled as values.
	 * Used both for post-claim verification and for observe/adopt after an
	 * ambiguous deploy.
	 */
	probeSiteAccess(input: {
		readonly siteId: string;
		readonly tokenRef: SecretRef;
	}): Promise<SiteAccess>;
};

function parseSite(body: string, expectedId: string): NetlifySite {
	let parsed: ReturnType<typeof parseJsonValue>;
	try {
		parsed = parseJsonValue(body);
		if (parsed === null && body.trim() !== "null") {
			// SAFETY: parseJsonValue returns null both for JSON null and for
			// unparseable text; only the latter is a parse failure.
			throw new Error("not json");
		}
	} catch {
		throw new NetlifyProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"netlify site response was not json",
		);
	}
	if (!isJsonObject(parsed)) {
		throw new NetlifyProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"netlify site response was not an object",
		);
	}
	const id = isJsonString(parsed.id) ? parsed.id : undefined;
	const accountId = isJsonString(parsed.account_id)
		? parsed.account_id
		: isJsonString(parsed.account_slug)
			? parsed.account_slug
			: undefined;
	if (id === undefined || accountId === undefined) {
		// Without an owning account there is no ownership fact to compare, and a
		// verification that cannot compare must not pass.
		throw new NetlifyProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"netlify site response carried no id and owning account",
			{
				detail: {
					haveId: id !== undefined,
					haveAccount: accountId !== undefined,
				},
			},
		);
	}
	if (id !== expectedId) {
		throw new NetlifyProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"netlify returned a different site identity; access and ownership are unproven",
		);
	}
	const accountSlug = isJsonString(parsed.account_slug)
		? parsed.account_slug
		: undefined;
	const url = isJsonString(parsed.ssl_url)
		? parsed.ssl_url
		: isJsonString(parsed.url)
			? parsed.url
			: undefined;
	return {
		id,
		name: isJsonString(parsed.name) ? parsed.name : id,
		accountId,
		...(accountSlug !== undefined ? { accountSlug } : undefined),
		...(url !== undefined ? { url } : undefined),
	};
}

/** Site ids appear in a URL path, so they are constrained before use. */
function assertSiteId(siteId: string): string {
	if (!/^[A-Za-z0-9._~-]{1,128}$/u.test(siteId)) {
		throw new NetlifyProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"site id is not a plain identifier and cannot be placed in a request path",
		);
	}
	return siteId;
}

export function createNetlifyClient(
	options: NetlifyClientOptions,
): NetlifyClient {
	const policy = options.policy ?? DEFAULT_TRANSPORT_POLICY;
	const transport = createGuardedTransport(options.transport, policy);
	const timeoutMs = options.timeoutMs ?? policy.timeoutMs;
	const maxResponseBytes = options.maxResponseBytes ?? policy.maxResponseBytes;

	const request = async (input: {
		readonly siteId: string;
		readonly tokenRef: SecretRef;
	}) => {
		const token = await resolveSecret(options.resolver, input.tokenRef);
		return transport.request({
			method: "GET",
			url: `${NETLIFY_API_BASE}/api/v1/sites/${assertSiteId(input.siteId)}`,
			headers: {
				// The one place a token is materialized, and it goes straight
				// into a header on an allowlisted https origin.
				authorization: `Bearer ${token.expose()}`,
				accept: "application/json",
			},
			timeoutMs,
			maxResponseBytes,
		});
	};

	return {
		async readSite(input) {
			const response = await request(input);
			if (response.status !== 200) {
				throw providerErrorForStatus(response.status, {
					method: "GET",
					operation: "readSite",
					body: response.body,
				});
			}
			return parseSite(response.body, input.siteId);
		},

		async probeSiteAccess(input) {
			const response = await request(input);
			if (response.status === 200) {
				return {
					kind: "readable",
					site: parseSite(response.body, input.siteId),
				};
			}
			if (response.status === 401 || response.status === 403) {
				return { kind: "forbidden" };
			}
			if (response.status === 404 || response.status === 410) {
				return { kind: "absent" };
			}
			throw providerErrorForStatus(response.status, {
				method: "GET",
				operation: "probeSiteAccess",
				body: response.body,
			});
		},
	};
}

export type IdempotencyState = "fresh" | "replayed";

export type IdempotencyRecord = {
	readonly key: string;
	readonly siteId?: string;
	readonly state: IdempotencyState;
};

/**
 * Attempt bookkeeping for the deploy command.
 *
 * `netlify deploy` is not an idempotent API call: a retry after an ambiguous
 * failure creates a *second* site rather than converging on the first. So the
 * key is recorded before the CLI runs, and a repeat of the same key refuses to
 * deploy again and hands back whatever was observed the first time — which is
 * either a site to adopt or nothing, and both are better than a silent orphan.
 */
export type IdempotencyStore = {
	begin(key: string): Promise<IdempotencyRecord>;
	complete(key: string, siteId: string): Promise<void>;
	get(key: string): Promise<IdempotencyRecord | undefined>;
};

export function createInMemoryIdempotencyStore(): IdempotencyStore {
	const records = new Map<string, { siteId?: string }>();
	return {
		async begin(key) {
			const existing = records.get(key);
			if (existing !== undefined) {
				return {
					key,
					...(existing.siteId !== undefined
						? { siteId: existing.siteId }
						: undefined),
					state: "replayed",
				};
			}
			records.set(key, {});
			return { key, state: "fresh" };
		},
		async complete(key, siteId) {
			records.set(key, { siteId });
		},
		async get(key) {
			const existing = records.get(key);
			if (existing === undefined) return undefined;
			return {
				key,
				...(existing.siteId !== undefined
					? { siteId: existing.siteId }
					: undefined),
				state: "replayed",
			};
		},
	};
}
