import type { TenantId } from "@hobo/core";
import {
	type Account,
	type ClaimsData,
	createOperator,
	createServer,
	createUser,
	decode,
	encode,
	parseCreds,
	type User,
} from "@nats-io/jwt";
import { describe, expect, it } from "vitest";
import {
	accountOfCredentials,
	DEVICE_CREDENTIAL_MS,
	mintAccount,
	mintAuthorizationResponse,
	mintDeviceUser,
	staticCredentials,
	tenantKeys,
	verifyAuthorizationRequest,
	verifyJwt,
} from "../src/bus/nats-jwt.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
// SAFETY: a literal tenant id for the test, matching the TenantId pattern.
const TENANT = "acme" as TenantId;
const operatorSeed = () => decoder.decode(createOperator().getSeed());

describe("tenant keys (A7)", () => {
	it("derives the same account and keys from the same operator seed and tenant", () => {
		const seed = operatorSeed();
		const once = tenantKeys(seed, TENANT);
		const again = tenantKeys(seed, TENANT);
		// SAFETY: a second literal tenant id.
		const other = tenantKeys(seed, "beta" as TenantId);
		expect(once.account.getPublicKey()).toBe(again.account.getPublicKey());
		expect(once.account.getPublicKey()).toMatch(/^A/u);
		expect(once.users.authority.getPublicKey()).toMatch(/^U/u);
		expect(once.xkey.getPublicKey()).toMatch(/^X/u);
		expect(once.scoped.executor.getPublicKey()).toMatch(/^A/u);
		expect(other.account.getPublicKey()).not.toBe(once.account.getPublicKey());
		expect(
			new Set(Object.values(once.scoped).map((k) => k.getPublicKey())).size,
		).toBe(3);
	});

	it("mints the account with three scoped signing keys and the callout settings", async () => {
		const seed = operatorSeed();
		const keys = tenantKeys(seed, TENANT);
		const jwt = await mintAccount(keys, TENANT, seed);
		expect(verifyJwt(jwt)).toBe(true);
		const claims: ClaimsData<Account> = decode(jwt);
		expect(claims.name).toBe("T_acme");
		expect(claims.sub).toBe(keys.account.getPublicKey());
		const signing = (claims.nats.signing_keys ?? []).flatMap((key) =>
			key instanceof Object ? [key] : [],
		);
		expect(signing.map((key) => key.role).sort()).toEqual([
			"dispatcher",
			"executor",
			"observer",
		]);
		const executor = signing.find((key) => key.role === "executor");
		expect(executor?.template.pub?.allow).toContain("fleet.claim.>");
		expect(executor?.template.sub?.allow).toContain("fleet.relay.{{name()}}.>");
		expect(claims.nats.authorization?.auth_users).toEqual([
			keys.users.authority.getPublicKey(),
			keys.users.witness.getPublicKey(),
			keys.users.provisioner.getPublicKey(),
		]);
		expect(claims.nats.authorization?.allowed_accounts).toEqual([
			keys.account.getPublicKey(),
		]);
		expect(claims.nats.authorization?.xkey).toBe(keys.xkey.getPublicKey());
	});

	it("writes static credentials, the sentinel denied everything", async () => {
		const keys = tenantKeys(operatorSeed(), TENANT);
		const sentinel = await staticCredentials(keys, "sentinel");
		const parsed = await parseCreds(encoder.encode(sentinel));
		expect(parsed.uc.name).toBe("sentinel");
		expect(parsed.uc.nats.pub?.deny).toEqual([">"]);
		expect(parsed.uc.nats.sub?.deny).toEqual([">"]);
		expect(accountOfCredentials(sentinel)).toBe(keys.account.getPublicKey());
		const authority = await parseCreds(
			encoder.encode(await staticCredentials(keys, "authority")),
		);
		expect(authority.uc.nats.sub?.allow).toContain("$SYS.REQ.USER.AUTH");
		expect(authority.uc.nats.resp?.max).toBe(1);
		expect(() => accountOfCredentials("nothing")).toThrow();
	});
});

describe("device credentials (§6.7 step 4)", () => {
	it("names the user by member id, expires in 10 minutes and carries no permissions", async () => {
		const keys = tenantKeys(operatorSeed(), TENANT);
		const user = createUser().getPublicKey();
		const now = Date.parse("2026-11-13T10:00:00Z");
		const jwt = await mintDeviceUser({
			userNkey: user,
			memberId: `dev_${"a".repeat(32)}`,
			accountPublicKey: keys.account.getPublicKey(),
			scopedSeed: decoder.decode(keys.scoped.executor.getSeed()),
			nowMs: now,
		});
		expect(verifyJwt(jwt)).toBe(true);
		const claims: ClaimsData<User> = decode(jwt);
		expect(claims.name).toBe(`dev_${"a".repeat(32)}`);
		expect(claims.sub).toBe(user);
		expect(claims.iss).toBe(keys.scoped.executor.getPublicKey());
		expect(claims.nats.issuer_account).toBe(keys.account.getPublicKey());
		expect(claims.exp).toBe(Math.floor((now + DEVICE_CREDENTIAL_MS) / 1000));
		expect(claims.nats.pub).toBeUndefined();
		expect(claims.nats.sub).toBeUndefined();

		const response = await mintAuthorizationResponse({
			userNkey: user,
			serverId: createServer().getPublicKey(),
			accountPublicKey: keys.account.getPublicKey(),
			signerSeed: decoder.decode(keys.scoped.executor.getSeed()),
			answer: { jwt },
			nowMs: now,
		});
		expect(verifyJwt(response)).toBe(true);
		const answer: ClaimsData<{ jwt: string; issuer_account: string }> =
			decode(response);
		expect(answer.nats.jwt).toBe(jwt);
		expect(answer.nats.issuer_account).toBe(keys.account.getPublicKey());
	});
});

describe("callout request verification", () => {
	const request = async (
		signer = createServer(),
		id = signer.getPublicKey(),
		aud = "nats-authorization-request",
	) =>
		encode(
			// SAFETY: the jwt package's algorithm enum value for v2 JWTs.
			"ed25519-nkey" as Parameters<typeof encode>[0],
			{
				aud,
				jti: "x",
				iat: 1,
				iss: signer.getPublicKey(),
				name: "",
				sub: id,
				nats: {
					server_id: { id, name: "n1", host: "h" },
					user_nkey: createUser().getPublicKey(),
					client_info: { nonce: "abc" },
					connect_opts: { protocol: 1, auth_token: "t" },
					type: "authorization_request",
					version: 2,
				},
			},
			signer,
		);

	it("accepts a request signed by the server it names, and refuses any other", async () => {
		expect(verifyAuthorizationRequest(await request()).verified).toBe(true);
		const forger = createServer();
		const named = createServer().getPublicKey();
		expect(
			verifyAuthorizationRequest(await request(forger, named)).verified,
		).toBe(false);
		expect(
			verifyAuthorizationRequest(
				await request(createServer(), undefined, "NATS"),
			).verified,
		).toBe(false);
		const genuine = await request();
		const tampered = `${genuine.slice(0, -4)}AAAA`;
		expect(verifyAuthorizationRequest(tampered).verified).toBe(false);
		expect(verifyAuthorizationRequest("garbage").verified).toBe(false);
	});
});
