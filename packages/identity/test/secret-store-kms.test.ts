import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createMemorySecretsPort,
	type JwtSvidClaims,
	JwtSvidIssuer,
	type KmsLike,
	loadSecretStoreKms,
	type SecretsPort,
	verifyJwtWithJwks,
} from "../src/index.js";

// O37: the authority's token key is shared and rotates.
const PREFIX = "fleet/token-signing";
const FIRST_KID = `${PREFIX}#1`;
const NEXT_KID = `${PREFIX}#2`;
const ISSUER = "https://authority.fleet.example";
const AUDIENCE = "hobo-fleet";
const TOKEN_LIFETIME_S = 15 * 60;
const T0 = Date.parse("2026-11-13T10:00:00.000Z");

function claimsAt(nowMs: number): JwtSvidClaims {
	const now = Math.floor(nowMs / 1000);
	return {
		sub: "spiffe://hobo/fleet/member/m1",
		aud: AUDIENCE,
		tenant: "tenant-a",
		parentPrincipal: { kind: "service", id: "fleet-authority" },
		codeVersion: { digest: `sha256:${"a".repeat(64)}`, version: "1" },
		scope: [],
		iat: now,
		nbf: now,
		exp: now + TOKEN_LIFETIME_S,
	};
}

function issuerOver(kms: KmsLike, kid = FIRST_KID): JwtSvidIssuer {
	return new JwtSvidIssuer({
		issuerUrl: ISSUER,
		kms,
		activeKeyId: kid,
		jwksKeyIds: [kid],
	});
}

function verify(token: string, issuer: JwtSvidIssuer, nowMs: number) {
	return verifyJwtWithJwks(token, issuer.jwks(), {
		issuer: ISSUER,
		audience: AUDIENCE,
		now: Math.floor(nowMs / 1000),
	});
}

async function settled(
	secrets: SecretsPort,
	predicate: (kms: KmsLike) => boolean,
): Promise<KmsLike> {
	let latest = await loadSecretStoreKms(secrets, { prefix: PREFIX });
	await vi.waitFor(async () => {
		latest = await loadSecretStoreKms(secrets, { prefix: PREFIX });
		expect(predicate(latest)).toBe(true);
	});
	return latest;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("loadSecretStoreKms (O37)", () => {
	it("gives two issuers over one secret store the same key, so each verifies the other's tokens", async () => {
		const secrets = createMemorySecretsPort();
		const a = issuerOver(await loadSecretStoreKms(secrets, { prefix: PREFIX }));
		const b = issuerOver(await loadSecretStoreKms(secrets, { prefix: PREFIX }));
		const now = Date.now();

		const fromA = await a.signJwtSvid(claimsAt(now));
		const fromB = await b.signJwtSvid(claimsAt(now));

		await expect(verify(fromA, b, now)).resolves.toMatchObject({
			header: { kid: FIRST_KID },
		});
		await expect(verify(fromB, a, now)).resolves.toMatchObject({
			header: { kid: FIRST_KID },
		});
		expect(b.jwks()).toEqual(a.jwks());
	});

	it("creates the key once, also when two replicas start together", async () => {
		const secrets = createMemorySecretsPort();
		const [a, b] = await Promise.all([
			loadSecretStoreKms(secrets, { prefix: PREFIX }),
			loadSecretStoreKms(secrets, { prefix: PREFIX }),
		]);
		const c = await loadSecretStoreKms(secrets, { prefix: PREFIX });

		expect(a.publicJwk(FIRST_KID)).toEqual(b.publicJwk(FIRST_KID));
		expect(c.publicJwk(FIRST_KID)).toEqual(a.publicJwk(FIRST_KID));
		const versionsAfterStart = (await secrets.listVersions(PREFIX)).length;

		await loadSecretStoreKms(secrets, { prefix: PREFIX });
		await loadSecretStoreKms(secrets, { prefix: PREFIX });
		expect(await secrets.listVersions(PREFIX)).toHaveLength(versionsAfterStart);
		expect(secrets.names()).toEqual([PREFIX]);
	});

	it("keeps the previous key in the key set until its tokens expire, then drops it", async () => {
		vi.useFakeTimers({ toFake: ["Date"], now: T0 });
		const secrets = createMemorySecretsPort();
		const first = issuerOver(
			await loadSecretStoreKms(secrets, { prefix: PREFIX }),
		);
		const oldToken = await first.signJwtSvid(claimsAt(Date.now()));

		const rotated = first.rotateSigningKey(NEXT_KID);
		const newToken = await rotated.signJwtSvid(claimsAt(Date.now()));
		expect(rotated.jwks().keys.map((key) => key.kid)).toEqual([
			FIRST_KID,
			NEXT_KID,
		]);
		await expect(verify(oldToken, rotated, Date.now())).resolves.toBeDefined();
		await expect(verify(newToken, rotated, Date.now())).resolves.toBeDefined();
		// The previous key no longer signs.
		await expect(first.signJwtSvid(claimsAt(Date.now()))).rejects.toThrow(
			/retired/,
		);

		// The rotation reaches the secret store; a replica that loads now holds both keys.
		const replica = await settled(secrets, (kms) => kms.hasKey(NEXT_KID));
		expect(replica.hasKey(FIRST_KID)).toBe(true);
		expect(replica.publicJwk(NEXT_KID)).toEqual(
			rotated.kms.publicJwk(NEXT_KID),
		);
		const replicaIssuer = new JwtSvidIssuer({
			issuerUrl: ISSUER,
			kms: replica,
			activeKeyId: NEXT_KID,
			jwksKeyIds: [FIRST_KID, NEXT_KID],
		});
		await expect(
			verify(oldToken, replicaIssuer, Date.now()),
		).resolves.toBeDefined();

		// Just before the old key's last token expires, it is still published.
		vi.setSystemTime(T0 + TOKEN_LIFETIME_S * 1000 - 1000);
		expect(rotated.jwks().keys.map((key) => key.kid)).toContain(FIRST_KID);
		await expect(verify(oldToken, rotated, Date.now())).resolves.toBeDefined();

		// Once every token it signed has expired, it leaves the key set everywhere.
		vi.setSystemTime(T0 + TOKEN_LIFETIME_S * 1000 + 1000);
		expect(rotated.jwks().keys.map((key) => key.kid)).toEqual([NEXT_KID]);
		expect(rotated.kms.hasKey(FIRST_KID)).toBe(false);
		expect(replicaIssuer.jwks().keys.map((key) => key.kid)).toEqual([NEXT_KID]);
		const later = await loadSecretStoreKms(secrets, { prefix: PREFIX });
		expect(later.hasKey(FIRST_KID)).toBe(false);
		expect(later.hasKey(NEXT_KID)).toBe(true);
		await expect(verify(newToken, rotated, T0 + 1000)).resolves.toBeDefined();
	});

	it("refuses to create a second key under an existing key id", async () => {
		const kms = await loadSecretStoreKms(createMemorySecretsPort(), {
			prefix: PREFIX,
		});
		expect(() => kms.generateRsaKey(FIRST_KID)).toThrow(/already exists/);
	});

	it("fails closed when the secret store refuses for any reason but absence", async () => {
		const memory = createMemorySecretsPort();
		const refusing: SecretsPort = {
			...memory,
			async access() {
				return { status: "denied", reason: "no grant", code: "forbidden" };
			},
		};
		await expect(
			loadSecretStoreKms(refusing, { prefix: PREFIX }),
		).rejects.toThrow(/forbidden/);
		expect(memory.names()).toEqual([]);
	});

	it("fails closed when the store returns no key material", async () => {
		const memory = createMemorySecretsPort();
		await memory.put(PREFIX, "{}");
		const opaque: SecretsPort = {
			...memory,
			async access(name) {
				return {
					status: "ok",
					valueRef: `secref://${name}`,
					source: "provider-federation",
				};
			},
		};
		await expect(
			loadSecretStoreKms(opaque, { prefix: PREFIX }),
		).rejects.toThrow(/material/);
	});

	it("rejects a key ring that is not one", async () => {
		const memory = createMemorySecretsPort();
		await memory.put(PREFIX, JSON.stringify({ keys: [{ kid: 1 }] }));
		await expect(
			loadSecretStoreKms(memory, { prefix: PREFIX }),
		).rejects.toThrow(/key ring/);
	});

	it("never puts private key material in a key id, a JWK or an error", async () => {
		const secrets = createMemorySecretsPort();
		const kms = await loadSecretStoreKms(secrets, { prefix: PREFIX });
		const jwk = kms.publicJwk(FIRST_KID);
		expect(Object.keys(jwk).sort()).toEqual(
			["alg", "e", "kid", "kty", "n", "use"].sort(),
		);
		expect(() => kms.sign("missing", "x")).toThrow(/unknown KMS key: missing/);
	});
});

describe("loadSecretStoreKms active key (amendment 2)", () => {
	type Entry = Readonly<{ kid: string; retiredAt?: number }>;

	/** A ring holding `entries`, each with one valid private key, loaded fresh. */
	async function seeded(entries: readonly Entry[]): Promise<KmsLike> {
		const secrets = createMemorySecretsPort();
		await loadSecretStoreKms(secrets, { prefix: PREFIX });
		const access = await secrets.access(PREFIX);
		const stored: { keys: { privateKey: string }[] } = JSON.parse(
			access.status === "ok" ? (access.material ?? "{}") : "{}",
		);
		const privateKey = stored.keys[0]?.privateKey ?? "";
		await secrets.put(
			PREFIX,
			JSON.stringify({
				keys: entries.map((entry) => ({ ...entry, privateKey })),
			}),
		);
		return loadSecretStoreKms(secrets, { prefix: PREFIX });
	}

	it("answers the only key of a fresh ring, and lists it", async () => {
		const kms = await loadSecretStoreKms(createMemorySecretsPort(), {
			prefix: PREFIX,
		});
		expect(kms.activeKeyId?.()).toBe(FIRST_KID);
		expect(kms.keyIds?.()).toEqual([FIRST_KID]);
	});

	it("keeps the lowest-numbered unretired key active after add and publish, until the switch retires it", async () => {
		// Add + publish: #2 joins the ring unretired; #1 still signs.
		const published = await seeded([{ kid: NEXT_KID }, { kid: FIRST_KID }]);
		expect(published.activeKeyId?.()).toBe(FIRST_KID);
		expect(published.keyIds?.()).toEqual([FIRST_KID, NEXT_KID]);
		// Switch: #1 retires and verifies for 15 minutes more; #2 signs.
		const switched = await seeded([
			{ kid: FIRST_KID, retiredAt: Date.now() },
			{ kid: NEXT_KID },
		]);
		expect(switched.activeKeyId?.()).toBe(NEXT_KID);
		expect(switched.keyIds?.()).toEqual([FIRST_KID, NEXT_KID]);
		// Key numbers compare as numbers: #9 is below #10.
		const tens = await seeded([
			{ kid: `${PREFIX}#10` },
			{ kid: `${PREFIX}#9` },
		]);
		expect(tens.activeKeyId?.()).toBe(`${PREFIX}#9`);
		expect(tens.keyIds?.()).toEqual([`${PREFIX}#9`, `${PREFIX}#10`]);
	});

	it("follows generateRsaKey, which retires every older key at once", async () => {
		const kms = await loadSecretStoreKms(createMemorySecretsPort(), {
			prefix: PREFIX,
		});
		kms.generateRsaKey(NEXT_KID);
		expect(kms.activeKeyId?.()).toBe(NEXT_KID);
		expect(kms.keyIds?.()).toEqual([FIRST_KID, NEXT_KID]);
		const issuer = issuerOver(kms, kms.activeKeyId?.() ?? "");
		await expect(issuer.signJwtSvid(claimsAt(Date.now()))).resolves.toEqual(
			expect.any(String),
		);
	});

	it("drops a key from keyIds once its grace has passed", async () => {
		vi.useFakeTimers({ toFake: ["Date"], now: T0 });
		const kms = await loadSecretStoreKms(createMemorySecretsPort(), {
			prefix: PREFIX,
		});
		kms.generateRsaKey(NEXT_KID);
		vi.setSystemTime(T0 + TOKEN_LIFETIME_S * 1000 + 1000);
		expect(kms.keyIds?.()).toEqual([NEXT_KID]);
		expect(kms.activeKeyId?.()).toBe(NEXT_KID);
	});

	it("throws when every held key is retired", async () => {
		const kms = await seeded([{ kid: FIRST_KID, retiredAt: Date.now() }]);
		expect(kms.keyIds?.()).toEqual([FIRST_KID]);
		expect(() => kms.activeKeyId?.()).toThrow(/no active key/);
	});
});
