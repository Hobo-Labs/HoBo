import { describe, expect, it } from "vitest";

import {
	createDpopJtiCache,
	generateDpopKeyPair,
	mintDpopProof,
	verifyDpopProof,
} from "../../src/crypto/dpop.js";
import {
	mintJwtSvid,
	resolveSvidHmacSecret,
	spiffeIdForAgent,
	verifyJwtSvid,
} from "../../src/crypto/jwt-svid.js";
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

describe("DPoP ES256 + JWT-SVID (pure)", () => {
	it("mints and verifies DPoP proofs and rejects mismatches / replay", () => {
		const kp = generateDpopKeyPair();
		const token = "access-token-value";
		const htu = "https://broker.example.com/v1/place";
		const proof = mintDpopProof({
			keyPair: kp,
			htm: "POST",
			htu,
			accessToken: token,
		});
		const cache = createDpopJtiCache();
		const verified = verifyDpopProof({
			proof,
			htm: "POST",
			htu,
			accessToken: token,
			jtiCache: cache,
		});
		expect(verified.kid).toBe(kp.kid);
		expect(() =>
			verifyDpopProof({
				proof,
				htm: "GET",
				htu,
				accessToken: token,
			}),
		).toThrow(/htm/);
		expect(() =>
			verifyDpopProof({
				proof,
				htm: "POST",
				htu: "https://other.example.com/v1/place",
				accessToken: token,
			}),
		).toThrow(/htu/);
		expect(() =>
			verifyDpopProof({
				proof,
				htm: "POST",
				htu,
				accessToken: "different-token",
			}),
		).toThrow(/ath/);
		expect(() =>
			verifyDpopProof({
				proof,
				htm: "POST",
				htu,
				accessToken: token,
				jtiCache: cache,
			}),
		).toThrow(/replay/);

		const noHtu = mintDpopProof({
			keyPair: kp,
			htm: "POST",
			htu,
			accessToken: token,
			extra: { htu: undefined },
		});
		expect(() =>
			verifyDpopProof({
				proof: noHtu,
				htm: "POST",
				htu: "",
				accessToken: token,
			}),
		).toThrow(/htu/);
	});

	it("mints and verifies audience-bound JWT-SVID; guards production secrets", () => {
		const spiffeId = spiffeIdForAgent("worker-1");
		const minted = mintJwtSvid({
			spiffeId,
			audience: "https://broker.example.com",
			hmacSecret: "test-secret",
		});
		const claims = verifyJwtSvid({
			token: minted.token,
			audience: "https://broker.example.com",
			hmacSecret: "test-secret",
		});
		expect(claims.sub).toBe(spiffeId);
		expect(claims.jti).toMatch(/^[a-f0-9]{32}$/);
		expect(() =>
			verifyJwtSvid({
				token: minted.token,
				audience: "https://other.example.com",
				hmacSecret: "test-secret",
			}),
		).toThrow(/audience/);
		expect(() =>
			verifyJwtSvid({
				token: minted.token,
				audience: "https://broker.example.com",
				hmacSecret: "wrong-secret",
			}),
		).toThrow(/signature/);
		expect(() =>
			resolveSvidHmacSecret({
				env: { NODE_ENV: "production" },
			}),
		).toThrow(/required outside development/);
		expect(
			resolveSvidHmacSecret({
				env: { NODE_ENV: "development" },
				allowDefaultSecret: true,
			}),
		).toMatch(/hobo-local/);
	});
});
