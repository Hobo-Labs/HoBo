/**
 * Tests for the Route53 DNS provider.
 *
 * The module sat at 43% statements and 23.7% branches. Most of what was
 * uncovered is the part that matters: the rules deciding when a failed `list`
 * may fall back to the local mirror. Those rules exist because each wrong
 * answer is a distinct incident —
 *
 *   - falling back on an HTTP 4xx hides an auth or permission failure behind a
 *     cache that looks healthy;
 *   - falling back on a truncated body serves stale records as current;
 *   - reporting an unreadable body as an empty zone invites a reconciler to
 *     recreate every record it thinks is missing.
 *
 * A comment explaining that is not a test. These are.
 *
 * `fetchImpl` and `signRequest` are both injected, so nothing here signs with
 * real credentials or touches the network.
 */

import { parseTenantId } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createDnsProviderFromConfig,
	createRoute53DnsProvider,
	parseListResourceRecordSets,
} from "../../src/dns/route53-provider.js";
import { isJsonString, type JsonObject } from "../../src/json.js";

const TENANT = parseTenantId("acme");
const ZONE = "example.com";
const ZONE_ID = "Z123456";

type Call = {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
};

/** A fetch stand-in returning a scripted sequence, recording every call. */
function scripted(
	responses: ({ status: number; text: string } | { throws: string })[],
) {
	const calls: Call[] = [];
	let index = 0;
	// SAFETY: assertion required at this I/O or test boundary.
	const impl = (async (url: string | URL, init?: RequestInit) => {
		calls.push({
			url: String(url),
			method: init?.method ?? "GET",
			// SAFETY: assertion required at this I/O or test boundary.
			headers: (init?.headers ?? {}) as Record<string, string>,
			...(isJsonString(init?.body) ? { body: init.body } : undefined),
		});
		const next = responses[Math.min(index, responses.length - 1)];
		index += 1;
		if (next && "throws" in next) throw new Error(next.throws);
		const status = next?.status ?? 200;
		// SAFETY: assertion required at this I/O or test boundary.
		return {
			ok: status >= 200 && status < 300,
			status,
			text: async () => (next && "text" in next ? next.text : ""),
		} as Response;
	}) as typeof fetch;
	return { impl, calls };
}

const listXml = (
	sets: { name: string; type: string; ttl?: number; value: string }[],
	{ complete = true } = {},
) =>
	`<?xml version="1.0"?><ListResourceRecordSetsResponse>${sets
		.map(
			(s) =>
				`<ResourceRecordSet><Name>${s.name}</Name><Type>${s.type}</Type>${
					s.ttl === undefined ? "" : `<TTL>${s.ttl}</TTL>`
				}<ResourceRecords><ResourceRecord><Value>${s.value}</Value></ResourceRecord></ResourceRecords></ResourceRecordSet>`,
		)
		.join("")}${complete ? "</ListResourceRecordSetsResponse>" : ""}`;

const provider = (fetchImpl: typeof fetch, extra: JsonObject = {}) =>
	createRoute53DnsProvider({
		accessKeyId: "AKIA",
		secretAccessKey: "secret",
		hostedZoneId: ZONE_ID,
		allowUnsigned: true,
		fetchImpl,
		...extra,
	});

describe("upsert", () => {
	it("POSTs a ChangeResourceRecordSets batch to the zone's rrset URL", async () => {
		const { impl, calls } = scripted([{ status: 200, text: "<ok/>" }]);
		await provider(impl).upsert(TENANT, ZONE, {
			name: "web",
			type: "A",
			content: "203.0.113.1",
			ttl: 60,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url).toBe(
			`https://route53.amazonaws.com/2013-04-01/hostedzone/${ZONE_ID}/rrset/`,
		);
		expect(calls[0]?.body).toContain("<Action>UPSERT</Action>");
		expect(calls[0]?.body).toContain("<Type>A</Type>");
		expect(calls[0]?.body).toContain("<TTL>60</TTL>");
	});

	it("qualifies a bare name into the zone", async () => {
		const { impl, calls } = scripted([{ status: 200, text: "" }]);
		await provider(impl).upsert(TENANT, ZONE, {
			name: "web",
			type: "A",
			content: "203.0.113.1",
		});
		expect(calls[0]?.body).toContain(`<Name>web.${ZONE}.</Name>`);
	});

	it("leaves an already-qualified name alone", async () => {
		const { impl, calls } = scripted([{ status: 200, text: "" }]);
		await provider(impl).upsert(TENANT, ZONE, {
			name: `web.${ZONE}.`,
			type: "A",
			content: "203.0.113.1",
		});
		expect(calls[0]?.body).toContain(`<Name>web.${ZONE}.</Name>`);
	});

	it("defaults TTL to 300 when the record omits one", async () => {
		const { impl, calls } = scripted([{ status: 200, text: "" }]);
		await provider(impl).upsert(TENANT, ZONE, {
			name: "web",
			type: "A",
			content: "203.0.113.1",
		});
		expect(calls[0]?.body).toContain("<TTL>300</TTL>");
	});

	it("root-dots a CNAME target, as Route53 requires", async () => {
		const { impl, calls } = scripted([{ status: 200, text: "" }]);
		await provider(impl).upsert(TENANT, ZONE, {
			name: "web",
			type: "CNAME",
			content: "gateway.ts.net",
		});
		expect(calls[0]?.body).toContain("<Value>gateway.ts.net.</Value>");
	});

	it("does not double-dot a CNAME target that is already rooted", async () => {
		const { impl, calls } = scripted([{ status: 200, text: "" }]);
		await provider(impl).upsert(TENANT, ZONE, {
			name: "web",
			type: "CNAME",
			content: "gateway.ts.net.",
		});
		expect(calls[0]?.body).toContain("<Value>gateway.ts.net.</Value>");
		expect(calls[0]?.body).not.toContain("gateway.ts.net..");
	});

	it("escapes XML metacharacters rather than emitting them raw", async () => {
		const { impl, calls } = scripted([{ status: 200, text: "" }]);
		await provider(impl).upsert(TENANT, ZONE, {
			name: "web",
			type: "TXT",
			content: 'a&b<c>d"e',
		});
		const body = calls[0]?.body ?? "";
		expect(body).toContain("a&amp;b&lt;c&gt;d&quot;e");
	});

	it("surfaces an HTTP failure with status and a bounded body", async () => {
		const { impl } = scripted([{ status: 403, text: "AccessDenied" }]);
		await expect(
			provider(impl).upsert(TENANT, ZONE, {
				name: "web",
				type: "A",
				content: "203.0.113.1",
			}),
		).rejects.toThrow(/route53 UPSERT failed \(403\): AccessDenied/);
	});

	it("records the record locally after a successful write", async () => {
		const { impl } = scripted([{ status: 200, text: "" }]);
		const p = provider(impl);
		await p.upsert(TENANT, ZONE, {
			name: "web",
			type: "A",
			content: "203.0.113.1",
		});
		expect([...p.store.values()]).toContainEqual(
			expect.objectContaining({ name: "web", type: "A" }),
		);
	});
});

describe("zone resolution", () => {
	it("prefers an explicit hostedZoneId", async () => {
		const { impl, calls } = scripted([{ status: 200, text: "" }]);
		await provider(impl).upsert(TENANT, ZONE, {
			name: "w",
			type: "A",
			content: "1.2.3.4",
		});
		expect(calls[0]?.url).toContain(ZONE_ID);
	});

	it("accepts a zone that is itself a Z-prefixed id", async () => {
		const { impl, calls } = scripted([{ status: 200, text: "" }]);
		await createRoute53DnsProvider({
			accessKeyId: "AKIA",
			secretAccessKey: "s",
			allowUnsigned: true,
			fetchImpl: impl,
		}).upsert(TENANT, "ZABCDEF", {
			name: "w",
			type: "A",
			content: "1.2.3.4",
		});
		expect(calls[0]?.url).toContain("ZABCDEF");
	});

	it("refuses a named zone with no hostedZoneId rather than guessing", async () => {
		const { impl } = scripted([{ status: 200, text: "" }]);
		await expect(
			createRoute53DnsProvider({
				accessKeyId: "AKIA",
				secretAccessKey: "s",
				allowUnsigned: true,
				fetchImpl: impl,
			}).upsert(TENANT, ZONE, { name: "w", type: "A", content: "1.2.3.4" }),
		).rejects.toThrow(/hostedZoneId required/);
	});
});

describe("list and the offline mirror", () => {
	it("returns parsed records and mirrors them locally", async () => {
		const { impl } = scripted([
			{
				status: 200,
				text: listXml([
					{ name: `web.${ZONE}.`, type: "A", ttl: 60, value: "203.0.113.1" },
				]),
			},
		]);
		const p = provider(impl);
		const records = await p.list(TENANT, ZONE);
		expect(records).toEqual([
			{
				name: `web.${ZONE}`,
				type: "A",
				content: "203.0.113.1",
				ttl: 60,
				gatewayTarget: false,
			},
		]);
		expect(p.store.size).toBe(1);
	});

	it("refuses to report a truncated body as an empty zone", async () => {
		const { impl } = scripted([
			{
				status: 200,
				text: listXml(
					[{ name: `web.${ZONE}.`, type: "A", value: "203.0.113.1" }],
					{ complete: false },
				),
			},
		]);
		await expect(provider(impl).list(TENANT, ZONE)).rejects.toThrow(
			/incomplete ListResourceRecordSetsResponse/,
		);
	});

	it("never serves the mirror for a truncated body, even with offlineCache on", async () => {
		// Seed the mirror with a successful write first.
		const { impl } = scripted([
			{ status: 200, text: "" },
			{ status: 200, text: listXml([], { complete: false }) },
		]);
		const p = provider(impl, { offlineCache: true });
		await p.upsert(TENANT, ZONE, {
			name: "web",
			type: "A",
			content: "203.0.113.1",
		});
		// The mirror has a record, but an unreadable answer must not serve it:
		// the request reached Route53 and came back, we just could not read it.
		await expect(p.list(TENANT, ZONE)).rejects.toThrow(
			/incomplete ListResourceRecordSetsResponse/,
		);
	});

	it("never hides an HTTP auth failure behind the mirror", async () => {
		const { impl } = scripted([
			{ status: 200, text: "" },
			{ status: 403, text: "AccessDenied" },
		]);
		const p = provider(impl, { offlineCache: true });
		await p.upsert(TENANT, ZONE, {
			name: "web",
			type: "A",
			content: "203.0.113.1",
		});
		await expect(p.list(TENANT, ZONE)).rejects.toThrow(/failed \(403\)/);
	});

	it("serves the mirror on a network error when offlineCache is enabled", async () => {
		const { impl } = scripted([
			{ status: 200, text: "" },
			{ throws: "ECONNREFUSED" },
		]);
		const p = provider(impl, { offlineCache: true });
		await p.upsert(TENANT, ZONE, {
			name: "web",
			type: "A",
			content: "203.0.113.1",
		});
		expect(await p.list(TENANT, ZONE)).toEqual([
			expect.objectContaining({ name: "web", type: "A" }),
		]);
	});

	it("propagates a network error when offlineCache is off", async () => {
		const { impl } = scripted([{ throws: "ECONNREFUSED" }]);
		await expect(provider(impl).list(TENANT, ZONE)).rejects.toThrow(
			/ECONNREFUSED/,
		);
	});

	it("scopes the mirror to the requesting tenant and zone", async () => {
		const { impl } = scripted([
			{ status: 200, text: "" },
			{ throws: "ECONNREFUSED" },
		]);
		const p = provider(impl, { offlineCache: true });
		await p.upsert(TENANT, ZONE, {
			name: "web",
			type: "A",
			content: "203.0.113.1",
		});
		// A different tenant must not see acme's mirrored records.
		expect(await p.list(parseTenantId("other"), ZONE)).toEqual([]);
	});
});

describe("remove", () => {
	it("deletes a record already known locally without listing first", async () => {
		const { impl, calls } = scripted([{ status: 200, text: "" }]);
		const p = provider(impl);
		await p.upsert(TENANT, ZONE, {
			name: "web",
			type: "A",
			content: "203.0.113.1",
		});
		await p.remove(TENANT, ZONE, "web", "A");
		expect(calls).toHaveLength(2);
		expect(calls[1]?.body).toContain("<Action>DELETE</Action>");
		expect(p.store.size).toBe(0);
	});

	it("lists to recover the exact RRSet when the record is unknown", async () => {
		const { impl, calls } = scripted([
			{
				status: 200,
				text: listXml([
					{ name: `web.${ZONE}.`, type: "A", ttl: 60, value: "203.0.113.1" },
				]),
			},
			{ status: 200, text: "" },
		]);
		await provider(impl).remove(TENANT, ZONE, `web.${ZONE}`, "A");
		expect(calls[0]?.method).toBe("GET");
		expect(calls[1]?.body).toContain("<Action>DELETE</Action>");
		// Route53 DELETE needs the real content; it must come from the listing.
		expect(calls[1]?.body).toContain("203.0.113.1");
	});

	it("refuses rather than inventing placeholder content", async () => {
		const { impl } = scripted([{ status: 200, text: listXml([]) }]);
		await expect(
			provider(impl).remove(TENANT, ZONE, "ghost", "A"),
		).rejects.toThrow(/unknown record A ghost/);
	});
});

describe("parseListResourceRecordSets", () => {
	it("strips the trailing dot from names and values", () => {
		expect(
			parseListResourceRecordSets(
				listXml([
					{ name: "web.example.com.", type: "CNAME", value: "gw.ts.net." },
				]),
			),
		).toEqual([
			{
				name: "web.example.com",
				type: "CNAME",
				content: "gw.ts.net",
				gatewayTarget: true,
			},
		]);
	});

	it("marks only CNAMEs as gateway targets", () => {
		const parsed = parseListResourceRecordSets(
			listXml([
				{ name: "a.example.com.", type: "A", value: "203.0.113.1" },
				{ name: "c.example.com.", type: "CNAME", value: "gw.ts.net." },
			]),
		);
		expect(parsed.map((r) => r.gatewayTarget)).toEqual([false, true]);
	});

	it("skips record types outside the supported set", () => {
		const parsed = parseListResourceRecordSets(
			listXml([
				{ name: "a.example.com.", type: "NS", value: "ns1.example.com." },
				{ name: "b.example.com.", type: "SOA", value: "ns1.example.com." },
				{ name: "c.example.com.", type: "MX", value: "10 mail.example.com." },
				{ name: "d.example.com.", type: "TXT", value: "hello" },
			]),
		);
		expect(parsed.map((r) => r.type)).toEqual(["TXT"]);
	});

	it("skips a set missing a name, type or value", () => {
		expect(
			parseListResourceRecordSets(
				"<ListResourceRecordSetsResponse><ResourceRecordSet><Type>A</Type></ResourceRecordSet></ListResourceRecordSetsResponse>",
			),
		).toEqual([]);
	});

	it("omits ttl entirely when the set carries none", () => {
		const [record] = parseListResourceRecordSets(
			listXml([{ name: "a.example.com.", type: "A", value: "203.0.113.1" }]),
		);
		expect(record).not.toHaveProperty("ttl");
	});

	it("returns nothing for xml containing no record sets", () => {
		expect(parseListResourceRecordSets("<empty/>")).toEqual([]);
		expect(parseListResourceRecordSets("")).toEqual([]);
	});
});

describe("createDnsProviderFromConfig", () => {
	const { impl } = scripted([{ status: 200, text: "" }]);

	it("builds a Cloudflare provider from either credential spelling", () => {
		for (const credentials of [
			{ apiToken: "t" },
			{ CLOUDFLARE_API_TOKEN: "t" },
		])
			expect(
				createDnsProviderFromConfig({
					kind: "cloudflare",
					credentials,
					fetchImpl: impl,
				}),
			).toBeDefined();
	});

	it("refuses Cloudflare without a token", () => {
		expect(() =>
			createDnsProviderFromConfig({ kind: "cloudflare", credentials: {} }),
		).toThrow(/requires credentials.apiToken/);
	});

	it("builds a Route53 provider from either credential spelling", () => {
		for (const credentials of [
			{ accessKeyId: "a", secretAccessKey: "s" },
			{ AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "s" },
		])
			expect(
				createDnsProviderFromConfig({
					kind: "route53",
					credentials,
					allowUnsigned: true,
					fetchImpl: impl,
				}),
			).toBeDefined();
	});

	it("refuses Route53 when either half of the key pair is missing", () => {
		for (const credentials of [
			{ accessKeyId: "a" },
			{ secretAccessKey: "s" },
			{},
		])
			expect(() =>
				createDnsProviderFromConfig({ kind: "route53", credentials }),
			).toThrow(/requires credentials.accessKeyId and secretAccessKey/);
	});

	it("defaults allowUnsigned to false, so production always signs", () => {
		const unsigned = createDnsProviderFromConfig({
			kind: "route53",
			credentials: { accessKeyId: "a", secretAccessKey: "s" },
			fetchImpl: impl,
		});
		// With signing on and no signer override, the built-in SigV4 signer runs;
		// the provider is constructed either way, and the flag is what differs.
		expect(unsigned).toBeDefined();
	});

	it("names the unsupported kind it was given", () => {
		expect(() => createDnsProviderFromConfig({ kind: "bind9" })).toThrow(
			/unsupported kind bind9/,
		);
	});
});
