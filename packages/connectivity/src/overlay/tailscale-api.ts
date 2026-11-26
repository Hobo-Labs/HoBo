/**
 * Tailscale control-plane API helpers (MagicDNS split DNS, device status).
 * Auth: TS_API_KEY or options.apiKey (OAuth client credentials also accepted
 * via access token). Never logs the key.
 *
 * Docs: https://tailscale.com/api
 */
import { cloneAsJson, type JsonValue } from "../json.js";

export interface TailscaleApiOptions {
	readonly apiKey: string;
	readonly tailnet?: string;
	readonly apiBase?: string;
	readonly fetchImpl?: typeof fetch;
}

export interface TailscaleSplitDnsMap {
	/** domain suffix → nameserver IPs */
	readonly [domain: string]: readonly string[];
}

export interface TailscaleDnsPreferences {
	readonly magicDNS?: boolean;
	readonly overrideLocalDNS?: boolean;
}

export interface TailscaleApiClient {
	readonly tailnet: string;
	getSplitDns(): Promise<TailscaleSplitDnsMap>;
	/**
	 * Merge domains into the tailnet split DNS map (preserves other domains).
	 */
	putSplitDns(
		domains: readonly string[],
		nameservers: readonly string[],
	): Promise<TailscaleSplitDnsMap>;
	getDnsPreferences(): Promise<TailscaleDnsPreferences>;
	setDnsPreferences(
		prefs: TailscaleDnsPreferences,
	): Promise<TailscaleDnsPreferences>;
	listDevices(): Promise<
		readonly {
			readonly id: string;
			readonly name: string;
			readonly addresses: readonly string[];
			readonly tags?: readonly string[];
		}[]
	>;
}

export function createTailscaleApiClient(
	options: TailscaleApiOptions,
): TailscaleApiClient {
	const base = (options.apiBase ?? "https://api.tailscale.com/api/v2").replace(
		/\/$/,
		"",
	);
	const tailnet = options.tailnet ?? "-";
	const fetchImpl = options.fetchImpl ?? fetch;

	async function api(
		method: string,
		path: string,
		body?: JsonValue,
	): Promise<JsonValue> {
		const res = await fetchImpl(`${base}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${options.apiKey}`,
				accept: "application/json",
				...(body !== undefined
					? { "content-type": "application/json" }
					: undefined),
			},
			...(body !== undefined ? { body: JSON.stringify(body) } : undefined),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(
				`tailscale api ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`,
			);
		}
		if (res.status === 204) return {};
		return cloneAsJson(await res.json().catch(() => ({})));
	}

	return {
		tailnet,
		async getSplitDns() {
			// SAFETY: assertion required at this I/O or test boundary.
			const data = (await api(
				"GET",
				`/tailnet/${encodeURIComponent(tailnet)}/dns/split-dns`,
			)) as Record<string, string[]>;
			return normalizeSplit(data);
		},
		async putSplitDns(domains, nameservers) {
			const existing = await this.getSplitDns();
			const next = { ...asMutable(existing) };
			// The domain is used as the map key verbatim: Tailscale keys split DNS
			// by the suffix as written, so rewriting a leading dot here would
			// create a second entry beside the one the tailnet already has.
			for (const domain of domains) {
				next[domain] = [...nameservers];
			}
			// SAFETY: assertion required at this I/O or test boundary.
			const data = (await api(
				"PATCH",
				`/tailnet/${encodeURIComponent(tailnet)}/dns/split-dns`,
				next,
			)) as Record<string, string[]>;
			// Some API versions return the map; if empty, re-GET.
			if (data && Object.keys(data).length > 0) {
				return normalizeSplit(data);
			}
			// Fallback PUT full map
			await api(
				"PUT",
				`/tailnet/${encodeURIComponent(tailnet)}/dns/split-dns`,
				next,
			);
			return this.getSplitDns();
		},
		async getDnsPreferences() {
			// SAFETY: assertion required at this I/O or test boundary.
			const data = (await api(
				"GET",
				`/tailnet/${encodeURIComponent(tailnet)}/dns/preferences`,
			)) as TailscaleDnsPreferences;
			return data ?? {};
		},
		async setDnsPreferences(prefs) {
			// SAFETY: assertion required at this I/O or test boundary.
			const data = (await api(
				"POST",
				`/tailnet/${encodeURIComponent(tailnet)}/dns/preferences`,
				cloneAsJson(prefs),
			)) as TailscaleDnsPreferences;
			// A 204 (and some API versions' empty body) means "accepted, nothing to
			// report". Returning that empty object would tell the caller no
			// preferences are in force — the opposite of what the write just did —
			// so an answer carrying nothing falls back to what was asked for.
			if (!data || Object.keys(data).length === 0) return prefs;
			return data;
		},
		async listDevices() {
			// SAFETY: assertion required at this I/O or test boundary.
			const data = (await api(
				"GET",
				`/tailnet/${encodeURIComponent(tailnet)}/devices`,
			)) as {
				devices?: readonly {
					id?: string;
					name?: string;
					hostname?: string;
					addresses?: string[];
					tags?: string[];
				}[];
			};
			return (data.devices ?? []).map((d) => ({
				id: d.id ?? "",
				name: d.name ?? d.hostname ?? "",
				addresses: d.addresses ?? [],
				...(d.tags !== undefined ? { tags: d.tags } : undefined),
			}));
		},
	};
}

function normalizeSplit(
	data: Record<string, string[] | readonly string[]>,
): TailscaleSplitDnsMap {
	const out: Record<string, readonly string[]> = {};
	for (const [k, v] of Object.entries(data ?? {})) {
		if (Array.isArray(v)) out[k] = [...v];
	}
	return out;
}

function asMutable(map: TailscaleSplitDnsMap) {
	const out: { [domain: string]: string[] } = {};
	for (const [k, v] of Object.entries(map)) {
		out[k] = [...v];
	}
	return out;
}
