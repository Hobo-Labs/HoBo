/**
 * Pure cryptographic unit tests (no HTTP / no PACT boundaries).
 * AWS SigV4 math. (DPoP lives in @hobo/fleet/keys and JWT-SVIDs in
 * @hobo/identity, each with its own tests.)
 */
import { describe, expect, it } from "vitest";

import { signAwsRequest } from "../../src/dns/aws-sigv4.js";
import { parseListResourceRecordSets } from "../../src/dns/route53-provider.js";

describe("AWS SigV4 (pure)", () => {
	it("produces stable Authorization header structure", () => {
		const signed = signAwsRequest({
			method: "POST",
			url: "https://route53.amazonaws.com/2013-04-01/hostedzone/Z1/rrset/",
			headers: {
				"Content-Type": "text/xml",
				Host: "route53.amazonaws.com",
			},
			body: "<xml/>",
			region: "us-east-1",
			service: "route53",
			credentials: {
				accessKeyId: "AKIAEXAMPLE",
				secretAccessKey: "secretsecretsecretsecretsecret12",
			},
			now: new Date("2026-07-27T15:00:00.000Z"),
		});
		expect(signed.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
		expect(signed.headers["x-amz-date"]).toBe("20260727T150000Z");
		expect(signed.headers.Authorization).toContain("Signature=");
		expect(signed.credentialScope).toContain("route53/aws4_request");
	});

	it("parses Route53 ListResourceRecordSets XML", () => {
		const listed = parseListResourceRecordSets(
			`<?xml version="1.0"?>
<ListResourceRecordSetsResponse>
  <ResourceRecordSets>
    <ResourceRecordSet>
      <Name>web.example.com.</Name>
      <Type>CNAME</Type>
      <TTL>300</TTL>
      <ResourceRecords><ResourceRecord><Value>funnel.ts.net.</Value></ResourceRecord></ResourceRecords>
    </ResourceRecordSet>
  </ResourceRecordSets>
</ListResourceRecordSetsResponse>`,
		);
		expect(listed).toHaveLength(1);
		expect(listed[0]?.type).toBe("CNAME");
		expect(listed[0]?.content).toContain("funnel");
		expect(
			parseListResourceRecordSets(
				"<ResourceRecordSet><Name>a.</Name><Type>A</Type><Value>1.2.3.4</Value></ResourceRecordSet>",
			),
		).toHaveLength(1);
	});
});
