/**
 * "I could not read the answer" must never mean "the record is not there".
 *
 * Both DNS providers used to collapse those. `findRecord` returning `null` is
 * licence to create, so an unread lookup duplicates a record on every retry;
 * `list` returning `[]` reports an empty zone. Cloudflare's cases came out of
 * the pact chaos matrix; Route53's came from reading it for the same shape.
 */
import { describe, expect, it } from "vitest";

import { createCloudflareDnsProvider } from "../../src/dns/cloudflare-provider.js";
import { createRoute53DnsProvider } from "../../src/dns/route53-provider.js";

// SAFETY: assertion required at this I/O or test boundary.
const TENANT = "acme" as never;
const ZONE = "example.com";
const RECORD = "web.example.com";
const CNAME = {
	name: RECORD,
	type: "CNAME",
	content: "funnel.ts.net",
	gatewayTarget: true,
} as const;

const LIST_XML = (records: string) =>
	`<?xml version="1.0"?><ListResourceRecordSetsResponse xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><ResourceRecordSets>${records}</ResourceRecordSets></ListResourceRecordSetsResponse>`;
const ONE_RECORD = LIST_XML(
	`<ResourceRecordSet><Name>web.example.com.</Name><Type>CNAME</Type><TTL>300</TTL><ResourceRecords><ResourceRecord><Value>funnel.ts.net.</Value></ResourceRecord></ResourceRecords></ResourceRecordSet>`,
);

/** Answers every request the same way, which is all these cases need. */
function respond(status: number, body: string): typeof fetch {
	// SAFETY: assertion required at this I/O or test boundary.
	return (async () => new Response(body, { status })) as typeof fetch;
}

function cloudflare(status: number, body: string) {
	return createCloudflareDnsProvider({
		apiToken: "test-token",
		zoneId: "zone-1",
		apiBase: "https://api.cloudflare.com/v4",
		fetchImpl: respond(status, body),
	});
}

function route53(status: number, body: string, offlineCache = false) {
	return createRoute53DnsProvider({
		accessKeyId: "AKIAEXAMPLE",
		secretAccessKey: "secret",
		hostedZoneId: "Z123",
		allowUnsigned: true,
		offlineCache,
		fetchImpl: respond(status, body),
	});
}

describe("cloudflare refuses to infer absence from an answer it did not get", () => {
	// `upsert` looks before it writes, so each of these is a lookup the driver
	// could not read — and each used to end in a create.
	it.each([
		["a 5xx", 500, '{"errors":[{"message":"boom"}]}', /failed \(500\)/],
		// 429 is the nastiest: the provider working correctly under load, which
		// is exactly when a retry loop is running and duplicating costs most.
		["a 429", 429, '{"errors":[]}', /failed \(429\)/],
		["a truncated 200", 200, '{"success":true,"res', /unreadable response/],
		["a non-JSON 200", 200, "not json at all", /unreadable response/],
	])("does not create after %s lookup", async (_label, status, body, expected) => {
		await expect(
			cloudflare(status, body).upsert(TENANT, ZONE, CNAME),
		).rejects.toThrow(expected);
	});

	it("does not report an unreadable 200 as an empty zone", async () => {
		await expect(
			cloudflare(200, "not json at all").list(TENANT, ZONE),
		).rejects.toThrow(
			/refusing to report an unreadable response as an empty zone/,
		);
	});

	it("still reports a genuinely empty result as empty", async () => {
		// The other half: a guard that refused everything would also be wrong.
		// `result: []` is the provider saying "there are none".
		await expect(
			cloudflare(200, '{"success":true,"result":[]}').list(TENANT, ZONE),
		).resolves.toEqual([]);
	});
});

describe("route53 refuses to infer an empty zone from a truncated body", () => {
	// Quieter than the JSON version: `res.text()` has no parse step, so a body
	// cut off mid-stream is a valid string with no complete record block in it.
	it.each([
		["truncated mid-record", ONE_RECORD.slice(0, ONE_RECORD.length / 2), false],
		// The offline mirror is for *network* failures. This request reached
		// Route53 and came back, so the mirror would present stale state as current.
		[
			"truncated, with the offline mirror on",
			'<?xml version="1.0"?><ListResourceRecord',
			true,
		],
	])("rejects a list response %s", async (_label, body, offlineCache) => {
		await expect(
			route53(200, body, offlineCache).list(TENANT, ZONE),
		).rejects.toThrow(/refusing to report a truncated body as an empty zone/);
	});

	it("still parses a complete response", async () => {
		const listed = await route53(200, ONE_RECORD).list(TENANT, ZONE);
		expect(listed).toEqual([
			{
				name: RECORD,
				type: "CNAME",
				content: "funnel.ts.net",
				ttl: 300,
				gatewayTarget: true,
			},
		]);
	});

	it("still reports a complete but empty response as empty", async () => {
		await expect(
			route53(200, LIST_XML("")).list(TENANT, ZONE),
		).resolves.toEqual([]);
	});
});
