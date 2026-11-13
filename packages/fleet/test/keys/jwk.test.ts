import { createHash } from "node:crypto";
import { parseTenantId } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { MemberKind } from "../../src/_generated/fleet_pb.js";
import { FleetParseError } from "../../src/errors.js";
import { parseFleetId, parseMemberName } from "../../src/ids.js";
import {
	generateDpopKey,
	jwkThumbprint,
	memberIdFromJwk,
	parsePublicJwk,
	sponsoredMemberId,
} from "../../src/keys/index.js";
import {
	decodeCompactJws,
	thumbprintOfMembers,
	verifyCompactJws,
} from "../../src/keys/jose.js";

// RFC 8037 Appendix A: the Ed25519 example key, its RFC 7638 thumbprint (A.3)
// and its JWS over "Example of Ed25519 signing" (A.4).
const RFC8037_X = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
const RFC8037_THUMBPRINT = "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k";
const RFC8037_JWS =
	"eyJhbGciOiJFZERTQSJ9.RXhhbXBsZSBvZiBFZDI1NTE5IHNpZ25pbmc.hgyY0il_MGCjP0JzlnLWG1PPOt7-09PGcvMg3AIbQR6dWbhijcNR4ki4iylGjg5BhVsPt9g7sVvpAr_MuM0KAg";
// RFC 7638 §3.1: the RSA example key and its thumbprint (canonicalisation only;
// RSA keys are refused by parsePublicJwk).
const RFC7638_N =
	"0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw";
const RFC7638_THUMBPRINT = "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs";
// RFC 9449 §4.1 / §6.1: the example DPoP key and its `jkt`.
const RFC9449_JWK = {
	kty: "EC",
	x: "l8tFrhx-34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFs",
	y: "9VE4jf_Ok_o64zbTTlcuNJajHmt6v9TDVrU0CdvGRDA",
	crv: "P-256",
};
const RFC9449_JKT = "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I";

function parsed(json: string) {
	const result = parsePublicJwk(json);
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

describe("parsePublicJwk", () => {
	it("accepts EC P-256 and OKP Ed25519 public keys, keeping only public members", () => {
		expect(
			parsed(JSON.stringify({ ...RFC9449_JWK, kid: "x", use: "sig" })),
		).toEqual({
			kty: "EC",
			crv: "P-256",
			x: RFC9449_JWK.x,
			y: RFC9449_JWK.y,
		});
		expect(
			parsed(JSON.stringify({ kty: "OKP", crv: "Ed25519", x: RFC8037_X })),
		).toEqual({ kty: "OKP", crv: "Ed25519", x: RFC8037_X });
	});

	it.each([
		["private EC member d", { ...RFC9449_JWK, d: "AAAA" }],
		[
			"private OKP member d",
			{
				kty: "OKP",
				crv: "Ed25519",
				x: RFC8037_X,
				d: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
			},
		],
		["an RSA key", { kty: "RSA", n: RFC7638_N, e: "AQAB" }],
		["X25519 (not a signing key)", { kty: "OKP", crv: "X25519", x: RFC8037_X }],
		["P-384", { ...RFC9449_JWK, crv: "P-384" }],
		["an EC key without y", { kty: "EC", crv: "P-256", x: RFC9449_JWK.x }],
		["a point not on the curve", { ...RFC9449_JWK, y: RFC9449_JWK.x }],
		["a short Ed25519 key", { kty: "OKP", crv: "Ed25519", x: "AAAA" }],
		["a non-string x", { kty: "OKP", crv: "Ed25519", x: 12 }],
	])("refuses %s", (_name, jwk) => {
		const result = parsePublicJwk(JSON.stringify(jwk));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("invalid-request");
	});

	it("refuses text that is not a JSON object", () => {
		for (const text of ["", "[]", "null", "{", '"jwk"'])
			expect(parsePublicJwk(text).ok).toBe(false);
	});
});

describe("jwkThumbprint (RFC 7638)", () => {
	it("matches the RFC 8037 A.3 Ed25519 vector", () => {
		expect(jwkThumbprint({ kty: "OKP", crv: "Ed25519", x: RFC8037_X })).toBe(
			RFC8037_THUMBPRINT,
		);
	});

	it("matches the RFC 9449 example key's jkt", () => {
		expect(jwkThumbprint(parsed(JSON.stringify(RFC9449_JWK)))).toBe(
			RFC9449_JKT,
		);
	});

	it("canonicalises like the RFC 7638 §3.1 RSA example", () => {
		expect(
			thumbprintOfMembers([
				["n", RFC7638_N],
				["kty", "RSA"],
				["e", "AQAB"],
			]),
		).toBe(RFC7638_THUMBPRINT);
	});

	it("does not depend on member order or extra members", () => {
		const a = parsed(JSON.stringify(RFC9449_JWK));
		const b = parsed(
			JSON.stringify({
				y: RFC9449_JWK.y,
				crv: "P-256",
				alg: "ES256",
				x: RFC9449_JWK.x,
				kty: "EC",
			}),
		);
		expect(jwkThumbprint(a)).toBe(jwkThumbprint(b));
	});
});

describe("compact JWS verification", () => {
	it("verifies the RFC 8037 A.4 EdDSA signature and refuses it altered", () => {
		const jwk = parsed(
			JSON.stringify({ kty: "OKP", crv: "Ed25519", x: RFC8037_X }),
		);
		// The A.4 payload is not JSON, so decoding refuses it; verify the raw signing input directly.
		expect(decodeCompactJws(RFC8037_JWS)).toBeUndefined();
		const [h, p, s] = RFC8037_JWS.split(".");
		expect(
			verifyCompactJws(
				{
					header: { alg: "EdDSA" },
					payload: {},
					signingInput: `${h}.${p}`,
					signature: Buffer.from(s ?? "", "base64url"),
				},
				jwk,
			),
		).toBe(true);
		expect(
			verifyCompactJws(
				{
					header: { alg: "EdDSA" },
					payload: {},
					signingInput: `${h}.${p}x`,
					signature: Buffer.from(s ?? "", "base64url"),
				},
				jwk,
			),
		).toBe(false);
	});
});

describe("member ids (§6.2)", () => {
	it("derives dev_ from the SHA-256 of the identity thumbprint", () => {
		const jwk = { kty: "OKP", crv: "Ed25519", x: RFC8037_X } as const;
		const expected = createHash("sha256")
			.update(RFC8037_THUMBPRINT)
			.digest("hex")
			.slice(0, 32);
		expect(memberIdFromJwk(jwk)).toBe(`dev_${expected}`);
	});

	it("derives bkd_ and tgt_ ids from tenant, kind, fleet and name", () => {
		const tenant = parseTenantId("acme");
		const fleet = parseFleetId("cache");
		const name = parseMemberName("r2-eu");
		const digest = (kind: string) =>
			createHash("sha256")
				.update(`acme\u0000${kind}\u0000cache\u0000r2-eu`)
				.digest("hex")
				.slice(0, 32);
		expect(sponsoredMemberId(tenant, MemberKind.BACKEND, fleet, name)).toBe(
			`bkd_${digest("BACKEND")}`,
		);
		expect(sponsoredMemberId(tenant, MemberKind.TARGET, fleet, name)).toBe(
			`tgt_${digest("TARGET")}`,
		);
	});

	it("gives a backend of the same name in another fleet another id", () => {
		const tenant = parseTenantId("acme");
		const name = parseMemberName("r2-eu");
		expect(
			sponsoredMemberId(tenant, MemberKind.BACKEND, parseFleetId("a"), name),
		).not.toBe(
			sponsoredMemberId(tenant, MemberKind.BACKEND, parseFleetId("b"), name),
		);
	});

	it("refuses to sponsor a device", () => {
		expect(() =>
			sponsoredMemberId(
				parseTenantId("acme"),
				MemberKind.DEVICE,
				parseFleetId("a"),
				parseMemberName("x"),
			),
		).toThrow(FleetParseError);
	});

	it("names a fresh DPoP key's signer as the identity key of its device", () => {
		const { signer, publicJwk } = generateDpopKey();
		expect(signer.keyId).toBe(`${memberIdFromJwk(publicJwk)}#identity`);
		expect(publicJwk.kty).toBe("EC");
	});
});
