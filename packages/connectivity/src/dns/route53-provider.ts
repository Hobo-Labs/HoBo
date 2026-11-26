import type {
	DnsProvider,
	DnsRecord,
	DnsRecordType,
	TenantId,
} from "@hobo/core";

import type { StringBag } from "../json.js";
import { type AwsCredentials, createRoute53SigV4Signer } from "./aws-sigv4.js";
import { createCloudflareDnsProvider } from "./cloudflare-provider.js";

export interface Route53DnsProviderOptions {
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly sessionToken?: string;
	readonly region?: string;
	/** Hosted zone ID (Z…). Required for writes when not resolving by name. */
	readonly hostedZoneId?: string;
	readonly fetchImpl?: typeof fetch;
	/**
	 * Optional pre-signer override. Default: built-in AWS SigV4 for route53.
	 */
	readonly signRequest?: (input: {
		readonly method: string;
		readonly url: string;
		readonly headers: Record<string, string>;
		readonly body: string;
	}) => Promise<{
		readonly headers: Record<string, string>;
	}>;
	/** Test-only: skip signing (never default for production). */
	readonly allowUnsigned?: boolean;
	readonly endpoint?: string;
	/**
	 * When true, list() may fall back to the local mirror on *network* errors only.
	 * HTTP 4xx/5xx never fall back (avoids hiding auth failures).
	 */
	readonly offlineCache?: boolean;
}

/**
 * A response that arrived but could not be read to the end.
 *
 * Distinct from an HTTP failure and from a network failure, because it needs
 * different handling from both: it must not fall back to the offline mirror,
 * and it must not be reported as an empty zone.
 */
class Route53UnreadableResponse extends Error {
	readonly code = "ROUTE53_UNREADABLE_RESPONSE";
	constructor(message: string) {
		super(message);
		this.name = "Route53UnreadableResponse";
	}
}

/**
 * Route53 DNS provider via ChangeResourceRecordSets.
 * Signs with AWS SigV4 by default (no SDK). Supports list via ListResourceRecordSets.
 */
export function createRoute53DnsProvider(
	options: Route53DnsProviderOptions,
): DnsProvider & {
	readonly kind: "route53";
	readonly store: ReadonlyMap<string, DnsRecord>;
} {
	const endpoint = (
		options.endpoint ?? "https://route53.amazonaws.com"
	).replace(/\/$/, "");
	const fetchImpl = options.fetchImpl ?? fetch;
	const store = new Map<string, DnsRecord>();
	const credentials: AwsCredentials = {
		accessKeyId: options.accessKeyId,
		secretAccessKey: options.secretAccessKey,
		...(options.sessionToken !== undefined
			? { sessionToken: options.sessionToken }
			: undefined),
	};
	const sign =
		options.signRequest ??
		(options.allowUnsigned ? null : createRoute53SigV4Signer(credentials));

	function key(tenantId: TenantId, zone: string, name: string, type: string) {
		return `${tenantId}::${zone}::${name}::${type}`;
	}

	function r53Name(name: string, zone: string): string {
		const n = name.endsWith(".") ? name : `${name}.`;
		if (n.endsWith(`${zone}.`) || n === `${zone}.`) return n;
		if (name.includes(zone)) return n;
		return `${name}.${zone}.`;
	}

	async function signedFetch(
		method: string,
		url: string,
		body?: string,
	): Promise<Response> {
		const baseHeaders: StringBag = {
			Host: new URL(url).host,
		};
		if (body !== undefined) {
			baseHeaders["Content-Type"] = "text/xml; charset=utf-8";
			baseHeaders["Content-Length"] = String(Buffer.byteLength(body));
		}
		let headers = baseHeaders;
		if (sign) {
			const signed = await sign({
				method,
				url,
				headers: baseHeaders,
				body: body ?? "",
			});
			headers = signed.headers;
		} else if (options.allowUnsigned) {
			headers = {
				...baseHeaders,
				"X-Amz-Access-Key-Id": options.accessKeyId,
			};
		} else {
			throw new Error("route53: no signer configured");
		}
		return fetchImpl(url, {
			method,
			headers,
			...(body !== undefined ? { body } : undefined),
		});
	}

	async function changeResourceRecordSets(
		zoneId: string,
		action: "UPSERT" | "DELETE",
		record: DnsRecord,
		zone: string,
	): Promise<void> {
		const fqdn = r53Name(record.name, zone);
		const value =
			record.type === "CNAME" && !record.content.endsWith(".")
				? `${record.content}.`
				: record.content;
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">
  <ChangeBatch>
    <Changes>
      <Change>
        <Action>${action}</Action>
        <ResourceRecordSet>
          <Name>${escapeXml(fqdn)}</Name>
          <Type>${record.type}</Type>
          <TTL>${record.ttl ?? 300}</TTL>
          <ResourceRecords>
            <ResourceRecord>
              <Value>${escapeXml(value)}</Value>
            </ResourceRecord>
          </ResourceRecords>
        </ResourceRecordSet>
      </Change>
    </Changes>
  </ChangeBatch>
</ChangeResourceRecordSetsRequest>`;

		const url = `${endpoint}/2013-04-01/hostedzone/${zoneId}/rrset/`;
		const res = await signedFetch("POST", url, xml);
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(
				`route53 ${action} failed (${res.status}): ${text.slice(0, 400)}`,
			);
		}
	}

	async function listResourceRecordSets(
		zoneId: string,
	): Promise<readonly DnsRecord[]> {
		const url = `${endpoint}/2013-04-01/hostedzone/${zoneId}/rrset?maxitems=100`;
		const res = await signedFetch("GET", url);
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(
				`route53 list failed (${res.status}): ${text.slice(0, 400)}`,
			);
		}
		const xml = await res.text();
		// A truncated body is the case this guards. `res.text()` has no parse
		// step, so a response cut off mid-stream arrives as a perfectly valid
		// string, and the scraper below simply finds no complete
		// `<ResourceRecordSet>` block in it — reporting an empty zone for an
		// answer we never finished reading. Route53 closes every list response
		// with this tag, so its absence means the body is incomplete.
		if (!xml.includes("</ListResourceRecordSetsResponse>")) {
			throw new Route53UnreadableResponse(
				"route53 list returned an incomplete ListResourceRecordSetsResponse; refusing to report a truncated body as an empty zone",
			);
		}
		return parseListResourceRecordSets(xml);
	}

	function zoneIdFor(zone: string): string {
		if (options.hostedZoneId) return options.hostedZoneId;
		if (zone.startsWith("Z")) return zone;
		throw new Error(`route53: hostedZoneId required to manage zone ${zone}`);
	}

	return {
		kind: "route53",
		get store() {
			return store;
		},
		async upsert(tenantId, zone, record) {
			const zoneId = zoneIdFor(zone);
			await changeResourceRecordSets(zoneId, "UPSERT", record, zone);
			store.set(key(tenantId, zone, record.name, record.type), record);
		},
		async remove(tenantId, zone, name, type) {
			let existing = store.get(key(tenantId, zone, name, type));
			if (!existing) {
				// Require exact RRSet for Route53 DELETE — never invent placeholder content.
				const listed = await this.list(tenantId, zone);
				existing = listed.find(
					(r) =>
						r.name === name ||
						r.name === name.replace(/\.$/, "") ||
						r.name.startsWith(`${name}.`),
				);
				if (existing && existing.type !== type) {
					existing = listed.find(
						(r) => r.type === type && r.name.includes(name),
					);
				}
			}
			if (!existing) {
				throw new Error(
					`route53 delete: unknown record ${type} ${name} (list/upsert first so content is known)`,
				);
			}
			const zoneId = zoneIdFor(zone);
			await changeResourceRecordSets(zoneId, "DELETE", existing, zone);
			store.delete(key(tenantId, zone, name, type));
		},
		async list(tenantId, zone) {
			const zoneId = zoneIdFor(zone);
			try {
				const remote = await listResourceRecordSets(zoneId);
				for (const r of remote) {
					store.set(key(tenantId, zone, r.name, r.type), r);
				}
				return remote;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				// The offline mirror exists for *network* failures. An unreadable
				// answer is not one: the request reached Route53 and came back, we
				// just could not read what it said, and serving a stale mirror for
				// that presents old state as current.
				if (error instanceof Route53UnreadableResponse) {
					throw error;
				}
				// Never hide HTTP auth/permission failures behind an empty cache.
				if (/failed \(\d{3}\)/.test(message) && !message.includes("(0)")) {
					throw error;
				}
				if (options.offlineCache === true) {
					const prefix = `${tenantId}::${zone}::`;
					return [...store.entries()]
						.filter(([k]) => k.startsWith(prefix))
						.map(([, v]) => v);
				}
				throw error;
			}
		},
	};
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Minimal XML parse for ListResourceRecordSetsResponse. */
export function parseListResourceRecordSets(xml: string): readonly DnsRecord[] {
	const records: DnsRecord[] = [];
	const setRe = /<ResourceRecordSet>([\s\S]*?)<\/ResourceRecordSet>/g;
	for (let match = setRe.exec(xml); match !== null; match = setRe.exec(xml)) {
		const block = match[1] ?? "";
		const name = textBetween(block, "Name")?.replace(/\.$/, "") ?? "";
		// SAFETY: assertion required at this I/O or test boundary.
		const type = textBetween(block, "Type") as DnsRecordType | null;
		const ttlRaw = textBetween(block, "TTL");
		const value = textBetween(block, "Value")?.replace(/\.$/, "") ?? "";
		if (!name || !type || !value) continue;
		if (type !== "A" && type !== "AAAA" && type !== "CNAME" && type !== "TXT") {
			continue;
		}
		records.push({
			name,
			type,
			content: value,
			...(ttlRaw !== null ? { ttl: Number(ttlRaw) } : undefined),
			gatewayTarget: type === "CNAME",
		});
	}
	return records;
}

function textBetween(xml: string, tag: string): string | null {
	const re = new RegExp(`<${tag}>([^<]*)</${tag}>`);
	const m = re.exec(xml);
	return m?.[1] ?? null;
}

/**
 * Factory that picks Cloudflare / Route53 / memory / dnscontrol from config.
 * Route53 always gets built-in SigV4 unless allowUnsigned is set for tests.
 */
export function createDnsProviderFromConfig(input: {
	readonly kind: string;
	readonly credentials?: Readonly<Record<string, string>>;
	readonly zoneId?: string;
	readonly fetchImpl?: typeof fetch;
	readonly signRequest?: Route53DnsProviderOptions["signRequest"];
	readonly allowUnsigned?: boolean;
}): DnsProvider {
	const creds = input.credentials ?? {};
	if (input.kind === "cloudflare") {
		const token = creds.apiToken ?? creds.CLOUDFLARE_API_TOKEN ?? "";
		if (!token) {
			throw new Error("cloudflare provider requires credentials.apiToken");
		}
		return createCloudflareDnsProvider({
			apiToken: token,
			...(creds.zoneId || input.zoneId
				? { zoneId: creds.zoneId ?? input.zoneId }
				: undefined),
			...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : undefined),
		});
	}
	if (input.kind === "route53") {
		const accessKeyId = creds.accessKeyId ?? creds.AWS_ACCESS_KEY_ID ?? "";
		const secretAccessKey =
			creds.secretAccessKey ?? creds.AWS_SECRET_ACCESS_KEY ?? "";
		if (!accessKeyId || !secretAccessKey) {
			throw new Error(
				"route53 provider requires credentials.accessKeyId and secretAccessKey",
			);
		}
		return createRoute53DnsProvider({
			accessKeyId,
			secretAccessKey,
			...(creds.sessionToken || creds.AWS_SESSION_TOKEN
				? {
						sessionToken: creds.sessionToken ?? creds.AWS_SESSION_TOKEN,
					}
				: undefined),
			...(creds.region ? { region: creds.region } : undefined),
			...(creds.hostedZoneId || input.zoneId
				? { hostedZoneId: creds.hostedZoneId ?? input.zoneId }
				: undefined),
			...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : undefined),
			...(input.signRequest ? { signRequest: input.signRequest } : undefined),
			allowUnsigned: input.allowUnsigned === true,
		});
	}
	throw new Error(
		`createDnsProviderFromConfig: unsupported kind ${input.kind}`,
	);
}
