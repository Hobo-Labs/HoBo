import type { DnsProvider, DnsRecord, DnsRecordType } from "@hobo/core";
import { cloneAsJson, type JsonValue } from "../json.js";

export interface CloudflareDnsProviderOptions {
	/** API token with Zone.DNS edit. Never log. */
	readonly apiToken: string;
	/** Zone ID (preferred) or resolve via zone name. */
	readonly zoneId?: string;
	readonly apiBase?: string;
	readonly fetchImpl?: typeof fetch;
}

interface CfListResponse {
	readonly success?: boolean;
	readonly result?: readonly {
		readonly id: string;
		readonly name: string;
		readonly type: string;
		readonly content: string;
		readonly ttl?: number;
	}[];
	readonly errors?: readonly { readonly message: string }[];
}

/**
 * Cloudflare DNS provider via REST API (no SDK hard dependency).
 * Credentials are never written into record content or logs by this module.
 */
export function createCloudflareDnsProvider(
	options: CloudflareDnsProviderOptions,
): DnsProvider & {
	readonly kind: "cloudflare";
	resolveZoneId(zone: string): Promise<string>;
} {
	const base = (options.apiBase ?? "https://api.cloudflare.com/v4").replace(
		/\/$/,
		"",
	);
	const fetchImpl = options.fetchImpl ?? fetch;
	const zoneCache = new Map<string, string>();

	async function api(
		path: string,
		init: RequestInit = {},
	): Promise<{ ok: boolean; status: number; body: JsonValue }> {
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${options.apiToken}`);
		headers.set("Content-Type", "application/json");
		const res = await fetchImpl(`${base}${path}`, { ...init, headers });
		// SAFETY: assertion required at this I/O or test boundary.
		const body = cloneAsJson(await res.json().catch(() => ({})));
		return { ok: res.ok, status: res.status, body };
	}

	async function resolveZoneId(zone: string): Promise<string> {
		if (options.zoneId) return options.zoneId;
		const cached = zoneCache.get(zone);
		if (cached) return cached;
		const res = await api(
			`/zones?name=${encodeURIComponent(zone)}&status=active`,
		);
		// SAFETY: assertion required at this I/O or test boundary.
		const data = res.body as CfListResponse;
		const id = data.result?.[0]?.id;
		if (!res.ok || !id) {
			throw new Error(
				`cloudflare: could not resolve zone id for ${zone} (status ${res.status})`,
			);
		}
		zoneCache.set(zone, id);
		return id;
	}

	/**
	 * Looks a record up, or refuses to answer.
	 *
	 * The `null` return means one specific thing — *the provider told us there
	 * is no such record* — and it must not be reachable any other way. Every
	 * caller treats `null` as licence to create, so any path that reaches it
	 * without a readable answer turns a bad minute at Cloudflare into a
	 * duplicate DNS record on every retry.
	 *
	 * Two ways that used to happen, both found by the pact chaos matrix. A
	 * non-2xx (a 500, a 429) parses to an error envelope with no `result`, and
	 * optional chaining read that as "no records". A 200 whose body was
	 * truncated or corrupted fails `res.json()`, which `api` softens to `{}` —
	 * also no `result`, also read as "no records". A response we could not read
	 * is not evidence of absence, so both now throw and let the caller retry.
	 */
	async function findRecord(
		zoneId: string,
		name: string,
		type: DnsRecordType,
	): Promise<{ id: string } | null> {
		const res = await api(
			`/zones/${zoneId}/dns_records?type=${type}&name=${encodeURIComponent(name)}`,
		);
		if (!res.ok) {
			throw new Error(
				`cloudflare: dns lookup for ${type} ${name} failed (${res.status})`,
			);
		}
		// SAFETY: assertion required at this I/O or test boundary.
		const data = res.body as CfListResponse;
		if (!Array.isArray(data.result)) {
			throw new Error(
				`cloudflare: dns lookup for ${type} ${name} returned a body with no record list; refusing to treat an unreadable response as "record absent"`,
			);
		}
		const hit = data.result[0];
		return hit ? { id: hit.id } : null;
	}

	return {
		kind: "cloudflare",
		resolveZoneId,
		async upsert(tenantId, zone, record) {
			void tenantId;
			const zoneId = await resolveZoneId(zone);
			const existing = await findRecord(zoneId, record.name, record.type);
			const payload = {
				type: record.type,
				name: record.name,
				content: record.content,
				ttl: record.ttl ?? 300,
				proxied: false,
				comment: "hobo-managed",
			};
			if (existing) {
				const res = await api(`/zones/${zoneId}/dns_records/${existing.id}`, {
					method: "PUT",
					body: JSON.stringify(payload),
				});
				if (!res.ok) {
					throw new Error(
						// SAFETY: assertion required at this I/O or test boundary.
						`cloudflare upsert failed (${res.status}): ${JSON.stringify((res.body as CfListResponse).errors ?? res.body)}`,
					);
				}
				return;
			}
			const res = await api(`/zones/${zoneId}/dns_records`, {
				method: "POST",
				body: JSON.stringify(payload),
			});
			if (!res.ok) {
				throw new Error(
					// SAFETY: assertion required at this I/O or test boundary.
					`cloudflare create failed (${res.status}): ${JSON.stringify((res.body as CfListResponse).errors ?? res.body)}`,
				);
			}
		},
		async remove(tenantId, zone, name, type) {
			void tenantId;
			const zoneId = await resolveZoneId(zone);
			const existing = await findRecord(zoneId, name, type);
			if (!existing) return;
			const res = await api(`/zones/${zoneId}/dns_records/${existing.id}`, {
				method: "DELETE",
			});
			if (!res.ok) {
				throw new Error(`cloudflare delete failed (${res.status})`);
			}
		},
		async list(tenantId, zone): Promise<readonly DnsRecord[]> {
			void tenantId;
			const zoneId = await resolveZoneId(zone);
			const res = await api(`/zones/${zoneId}/dns_records?per_page=100`);
			// SAFETY: assertion required at this I/O or test boundary.
			const data = res.body as CfListResponse;
			if (!res.ok) {
				throw new Error(`cloudflare list failed (${res.status})`);
			}
			// Same rule as findRecord: an unreadable 200 is not an empty zone.
			// `?? []` here would report "this zone has no records" to a caller
			// that may well act on it.
			if (!Array.isArray(data.result)) {
				throw new Error(
					"cloudflare list returned a body with no record list; refusing to report an unreadable response as an empty zone",
				);
			}
			return data.result.map((r) => ({
				name: r.name,
				// SAFETY: assertion required at this I/O or test boundary.
				type: r.type as DnsRecordType,
				content: r.content,
				...(r.ttl !== undefined ? { ttl: r.ttl } : undefined),
				gatewayTarget: true,
			}));
		},
	};
}
