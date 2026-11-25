import { create } from "@bufbuild/protobuf";
import { parseTenantId } from "@hobo/core";
import { MemberRecordSchema, MembershipSchema } from "@hobo/fleet";
import { createMemoryCredentialIssuer } from "@hobo/fleet/keys";
import {
	createInMemoryKms,
	createMemorySecretsPort,
	type KmsLike,
	loadSecretStoreKms,
} from "@hobo/identity";
import { describe, expect, it } from "vitest";
import {
	activeKeyId,
	createJwtCredentialIssuer,
	ringKeyIds,
} from "../../src/identity/issuer.js";

const ISSUER = "https://authority.example";
const PREFIX = "hobo-fleet/acme/token-signing";
const tenant = parseTenantId("acme");
const member = create(MemberRecordSchema, {
	memberId: `dev_${"a".repeat(32)}`,
	tenant: "acme",
	memberships: [create(MembershipSchema, { fleet: "build", name: "box" })],
});

async function harness() {
	let now = Date.parse("2026-11-13T10:00:00Z");
	let incarnation = 1;
	let kms: KmsLike = await loadSecretStoreKms(createMemorySecretsPort(), {
		prefix: PREFIX,
	});
	const issuer = createJwtCredentialIssuer({
		issuerUrl: ISSUER,
		prefix: PREFIX,
		kms: () => kms,
		incarnation: () => incarnation,
		now: () => now,
	});
	return {
		issuer,
		at: () => now,
		advance(ms: number) {
			now += ms;
		},
		restore() {
			incarnation += 1;
		},
		kms: () => kms,
		swap(next: KmsLike) {
			kms = next;
		},
	};
}

describe("the JWT credential issuer", () => {
	it("issues member and person tokens that verify with their binding", async () => {
		const h = await harness();
		const svid = await h.issuer.issueMember({
			member,
			audiences: [ISSUER, "nats"],
			jkt: "sign-key-thumbprint",
			ttlMs: 15 * 60_000,
		});
		expect(h.issuer.verify(svid.token, "nats", h.at())).toEqual({
			ok: true,
			value: {
				kind: "member",
				memberId: member.memberId,
				tenant,
				jkt: "sign-key-thumbprint",
				expiresAtMs: svid.expiresAtMs,
			},
		});
		const person = await h.issuer.issuePerson({
			principal: { kind: "user", id: "alice" },
			tenant,
			tags: ["fleet-admin"],
			jkt: "cli-key",
			ttlMs: 15 * 60_000,
		});
		const verified = h.issuer.verify(person.token, ISSUER, h.at());
		expect(verified).toMatchObject({
			ok: true,
			value: {
				kind: "person",
				principal: { kind: "user", id: "alice" },
				tags: ["fleet-admin"],
				jkt: "cli-key",
			},
		});
	});

	it("refuses another issuer's token, a wrong audience, an expired token and a tampered one", async () => {
		const h = await harness();
		const foreign = await createMemoryCredentialIssuer(h.at).issueMember({
			member,
			audiences: [ISSUER],
			jkt: "k",
			ttlMs: 60_000,
		});
		expect(h.issuer.verify(foreign.token, ISSUER, h.at()).ok).toBe(false);

		const otherRing = createInMemoryKms();
		otherRing.generateRsaKey(`${PREFIX}#1`);
		const lookalike = createJwtCredentialIssuer({
			issuerUrl: ISSUER,
			prefix: PREFIX,
			kms: () => otherRing,
			incarnation: () => 1,
			now: h.at,
		});
		const forged = await lookalike.issueMember({
			member,
			audiences: [ISSUER],
			jkt: "k",
			ttlMs: 60_000,
		});
		expect(h.issuer.verify(forged.token, ISSUER, h.at())).toMatchObject({
			ok: false,
			error: { code: "unauthenticated" },
		});

		const good = await h.issuer.issueMember({
			member,
			audiences: [ISSUER],
			jkt: "k",
			ttlMs: 60_000,
		});
		expect(h.issuer.verify(good.token, "elsewhere", h.at()).ok).toBe(false);
		expect(h.issuer.verify(good.token, ISSUER, h.at() + 61_000).ok).toBe(false);
		const [head, , signature] = good.token.split(".");
		const tampered = `${head}.${Buffer.from(JSON.stringify({ iss: ISSUER, kind: "member" })).toString("base64url")}.${signature}`;
		expect(h.issuer.verify(tampered, ISSUER, h.at()).ok).toBe(false);
	});

	it("refuses a token from before a restore as incarnation-stale", async () => {
		const h = await harness();
		const before = await h.issuer.issueMember({
			member,
			audiences: [ISSUER],
			jkt: "k",
			ttlMs: 60_000,
		});
		h.restore();
		expect(h.issuer.verify(before.token, ISSUER, h.at())).toMatchObject({
			ok: false,
			error: { code: "incarnation-stale" },
		});
		const after = await h.issuer.issueMember({
			member,
			audiences: [ISSUER],
			jkt: "k",
			ttlMs: 60_000,
		});
		expect(h.issuer.verify(after.token, ISSUER, h.at()).ok).toBe(true);
	});

	it("signs with the ring's active key and keeps verifying the retired one", async () => {
		const h = await harness();
		const old = await h.issuer.issueMember({
			member,
			audiences: [ISSUER],
			jkt: "k",
			ttlMs: 60_000,
		});
		expect(activeKeyId(h.kms(), PREFIX)).toBe(`${PREFIX}#1`);
		h.kms().generateRsaKey(`${PREFIX}#2`);
		expect(ringKeyIds(h.kms(), PREFIX)).toEqual([`${PREFIX}#1`, `${PREFIX}#2`]);
		expect(activeKeyId(h.kms(), PREFIX)).toBe(`${PREFIX}#2`);
		const fresh = await h.issuer.issueMember({
			member,
			audiences: [ISSUER],
			jkt: "k",
			ttlMs: 60_000,
		});
		expect(
			JSON.parse(
				Buffer.from(fresh.token.split(".")[0] ?? "", "base64url").toString(),
			).kid,
		).toBe(`${PREFIX}#2`);
		expect(h.issuer.verify(old.token, ISSUER, h.at()).ok).toBe(true);
		expect(h.issuer.verify(fresh.token, ISSUER, h.at()).ok).toBe(true);
		const jwks = JSON.parse(h.issuer.jwks());
		expect(jwks.keys.map((key: { kid: string }) => key.kid)).toEqual([
			`${PREFIX}#1`,
			`${PREFIX}#2`,
		]);
	});

	it("uses the ring's own activeKeyId when it offers one", () => {
		const ring = createInMemoryKms();
		ring.generateRsaKey(`${PREFIX}#1`);
		ring.generateRsaKey(`${PREFIX}#2`);
		const offered: KmsLike = { ...ring, activeKeyId: () => `${PREFIX}#1` };
		expect(activeKeyId(offered, PREFIX)).toBe(`${PREFIX}#1`);
		expect(activeKeyId(ring, PREFIX)).toBe(`${PREFIX}#1`);
	});
});
