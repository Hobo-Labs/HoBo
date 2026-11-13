import { create } from "@bufbuild/protobuf";
import { parseTenantId } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	MemberRecordSchema,
	MembershipSchema,
} from "../../src/_generated/fleet_pb.js";
import {
	createMemoryCredentialIssuer,
	parsePublicJwk,
} from "../../src/keys/index.js";
import { decodeCompactJws } from "../../src/keys/jose.js";

const NOW = Date.parse("2026-11-12T10:00:00Z");
const MEMBER = "dev_0123456789abcdef0123456789abcdef";
const AUDIENCE = "https://authority.fleet.test";

function member() {
	return create(MemberRecordSchema, {
		memberId: MEMBER,
		tenant: "acme",
		memberships: [create(MembershipSchema, { fleet: "hobo", name: "box" })],
	});
}

describe("createMemoryCredentialIssuer", () => {
	it("issues an ES256 member token bound to a key, verified for its audience", async () => {
		const issuer = createMemoryCredentialIssuer(() => NOW);
		const { token, expiresAtMs } = await issuer.issueMember({
			member: member(),
			audiences: [AUDIENCE],
			jkt: "jkt-1",
			ttlMs: 15 * 60_000,
		});
		expect(expiresAtMs).toBe(NOW + 15 * 60_000);
		expect(decodeCompactJws(token)?.header.alg).toBe("ES256");
		const verified = issuer.verify(token, AUDIENCE, NOW + 1_000);
		expect(verified).toEqual({
			ok: true,
			value: {
				kind: "member",
				memberId: MEMBER,
				tenant: "acme",
				jkt: "jkt-1",
				expiresAtMs,
			},
		});
		expect(issuer.verify(token, "https://elsewhere.test", NOW).ok).toBe(false);
		const expired = issuer.verify(token, AUDIENCE, expiresAtMs);
		expect(expired.ok ? undefined : expired.error.code).toBe("unauthenticated");
	});

	it("issues a person token with principal, tenant and tags", async () => {
		const issuer = createMemoryCredentialIssuer(() => NOW);
		const { token, expiresAtMs } = await issuer.issuePerson({
			principal: { kind: "user", id: "ada" },
			tenant: parseTenantId("acme"),
			tags: ["fleet-admin"],
			jkt: "jkt-2",
			ttlMs: 60_000,
		});
		expect(issuer.verify(token, AUDIENCE, NOW)).toEqual({
			ok: true,
			value: {
				kind: "person",
				principal: { kind: "user", id: "ada" },
				tenant: "acme",
				tags: ["fleet-admin"],
				jkt: "jkt-2",
				expiresAtMs,
			},
		});
	});

	it("accepts only tokens signed by its own key", async () => {
		const a = createMemoryCredentialIssuer(() => NOW);
		const b = createMemoryCredentialIssuer(() => NOW);
		const { token } = await a.issueMember({
			member: member(),
			audiences: [AUDIENCE],
			jkt: "jkt",
			ttlMs: 60_000,
		});
		expect(b.verify(token, AUDIENCE, NOW).ok).toBe(false);
		const [h, p, s] = token.split(".");
		const claims = JSON.parse(
			Buffer.from(p ?? "", "base64url").toString("utf8"),
		);
		const forged = `${h}.${Buffer.from(JSON.stringify({ ...claims, sub: "dev_ffffffffffffffffffffffffffffffff" })).toString("base64url")}.${s}`;
		expect(a.verify(forged, AUDIENCE, NOW).ok).toBe(false);
		expect(a.verify("garbage", AUDIENCE, NOW).ok).toBe(false);
	});

	it("publishes its public key, and only that, as a JWKS", async () => {
		const issuer = createMemoryCredentialIssuer(() => NOW);
		const jwks = JSON.parse(issuer.jwks());
		expect(jwks.keys).toHaveLength(1);
		const [key] = jwks.keys;
		expect(key.d).toBeUndefined();
		expect(key.alg).toBe("ES256");
		expect(parsePublicJwk(JSON.stringify(key)).ok).toBe(true);
		const { token } = await issuer.issuePerson({
			principal: { kind: "user", id: "ada" },
			tenant: parseTenantId("acme"),
			tags: [],
			jkt: "j",
			ttlMs: 1_000,
		});
		expect(decodeCompactJws(token)?.header.kid).toBe(key.kid);
	});
});
