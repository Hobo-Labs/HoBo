import { describe, expect, it } from "vitest";
import { IdentityService } from "../src/identity-service.js";
import { createInMemoryKms, type KmsLike } from "../src/issuer.js";
import type { JsonValue } from "../src/json.js";

const issuer = "https://identity.test";
const audience = "hobo-mcp";
const now = "2026-01-01T00:00:00.000Z";
const scope = [{ port: "mcp", resource: "capture_secret", verbs: ["call"] }];

type FixtureClaims = {
	iss: string;
	aud: string;
	sub: JsonValue | undefined;
	tenant: JsonValue | undefined;
	scope: JsonValue | undefined;
	iat: number;
	nbf: number;
	exp: number;
};

type FixtureHeader = { alg: string; kid: string; typ: string };

function fixture() {
	const kms = createInMemoryKms();
	const service = new IdentityService({
		issuerUrl: issuer,
		genesisKeyId: "key-1",
		kms,
	});
	return { kms, service };
}

function signClaims(
	kms: KmsLike,
	overrides: Partial<Pick<FixtureClaims, "sub" | "tenant" | "scope">> = {},
): string {
	const encode = (value: FixtureClaims | FixtureHeader) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	const header = encode({ alg: "RS256", kid: "key-1", typ: "JWT" });
	const payload = encode({
		iss: issuer,
		aud: audience,
		sub: "spiffe://yard/tenant-a/agent/a",
		tenant: "tenant-a",
		scope,
		iat: 1767225600,
		nbf: 1767225600,
		exp: 1767229200,
		...overrides,
	});
	const input = `${header}.${payload}`;
	return `${input}.${kms.sign("key-1", input).toString("base64url")}`;
}

describe("JWT-SVID gateway scope validation", () => {
	it("accepts a signed token with typed scope and identity claims", async () => {
		const { kms, service } = fixture();
		expect(
			await service.authenticateAtGateway({
				token: signClaims(kms),
				audience,
				now,
			}),
		).toEqual({
			status: "authenticated",
			subject: "spiffe://yard/tenant-a/agent/a",
			tenant: "tenant-a",
			scope,
		});
	});
	it.each([
		["null entry", [null]],
		["string entry", ["call"]],
		[
			"string verbs",
			[{ port: "mcp", resource: "capture_secret", verbs: "call" }],
		],
		[
			"mixed verbs",
			[{ port: "mcp", resource: "capture_secret", verbs: ["call", 1] }],
		],
		["missing port", [{ resource: "capture_secret", verbs: ["call"] }]],
		["empty resource", [{ port: "mcp", resource: "", verbs: ["call"] }]],
		["empty verb", [{ port: "mcp", resource: "capture_secret", verbs: [""] }]],
	])("rejects a signed token with %s", async (_name, invalidScope) => {
		const { kms, service } = fixture();
		expect(
			await service.authenticateAtGateway({
				token: signClaims(kms, { scope: invalidScope }),
				audience,
				now,
			}),
		).toEqual({ status: "denied", reason: "scope-claim-invalid" });
	});
	it("rejects a missing scope", async () => {
		const { kms, service } = fixture();
		expect(
			await service.authenticateAtGateway({
				token: signClaims(kms, { scope: undefined }),
				audience,
				now,
			}),
		).toEqual({ status: "denied", reason: "scope-claim-missing" });
	});
	it.each([
		["missing tenant", { tenant: undefined }],
		["empty tenant", { tenant: "" }],
		["numeric tenant", { tenant: 7 }],
		["missing subject", { sub: undefined }],
		["empty subject", { sub: "" }],
		["numeric subject", { sub: 42 }],
	])("rejects a signed token with %s", async (_name, claims) => {
		const { kms, service } = fixture();
		expect(
			await service.authenticateAtGateway({
				token: signClaims(kms, claims),
				audience,
				now,
			}),
		).toEqual({ status: "denied", reason: "identity-claim-invalid" });
	});
	it("still rejects a token with an untrusted signature", async () => {
		const { service } = fixture();
		const { kms } = fixture();
		expect(
			(
				await service.authenticateAtGateway({
					token: signClaims(kms),
					audience,
					now,
				})
			).status,
		).toBe("denied");
	});
});

describe("JWT verification boundaries", () => {
	it("does not expose malformed claim contents in the denial", async () => {
		const { service } = fixture();
		const header = Buffer.from(
			JSON.stringify({ alg: "RS256", kid: "key-1", typ: "JWT" }),
		).toString("base64url");
		const claims = Buffer.from("private-malformed-claim").toString("base64url");
		const result = await service.authenticateAtGateway({
			token: `${header}.${claims}.AA`,
			audience,
			now,
		});
		expect(result).toEqual({
			status: "denied",
			reason: "JWT contains invalid JSON",
		});
	});
	it("rejects extra JWT segments", async () => {
		const { kms, service } = fixture();
		expect(
			(
				await service.authenticateAtGateway({
					token: `${signClaims(kms)}.extra`,
					audience,
					now,
				})
			).status,
		).toBe("denied");
	});
	it("rejects noncanonical base64url signatures", async () => {
		const { kms, service } = fixture();
		expect(
			(
				await service.authenticateAtGateway({
					token: `${signClaims(kms)}!`,
					audience,
					now,
				})
			).status,
		).toBe("denied");
	});
	it("rejects an invalid verification clock", async () => {
		const { kms, service } = fixture();
		expect(
			(
				await service.authenticateAtGateway({
					token: signClaims(kms),
					audience,
					now: "not-a-date",
				})
			).status,
		).toBe("denied");
	});
	it.each([
		["expiry", '"exp":1e9999,"nbf":1767225600'],
		["not-before", '"exp":1767229200,"nbf":-1e9999'],
	])("rejects a signed token with a non-finite %s", async (_name, dates) => {
		const { kms, service } = fixture();
		const header = Buffer.from(
			JSON.stringify({ alg: "RS256", kid: "key-1", typ: "JWT" }),
		).toString("base64url");
		const claims = Buffer.from(
			`{"iss":"${issuer}","aud":"${audience}","sub":"agent","tenant":"tenant-a","scope":[],${dates}}`,
		).toString("base64url");
		const input = `${header}.${claims}`;
		const token = `${input}.${kms.sign("key-1", input).toString("base64url")}`;
		expect(
			(await service.authenticateAtGateway({ token, audience, now })).status,
		).toBe("denied");
	});
});
