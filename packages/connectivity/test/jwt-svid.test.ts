/**
 * JWT-SVIDs are the identity documents this system authenticates with, so the
 * only tests worth writing here are the ones that try to get a forged or expired
 * token accepted. A mint that produces a slightly wrong token fails loudly the
 * first time anyone uses it; a verify that accepts a token it should not fails
 * silently, forever, in the attacker's favour.
 *
 * The most important test in this file is the algorithm-confusion regression:
 * `verifyJwtSvid` used to let the *token's own header* choose the verification
 * algorithm, so an ES256-configured verifier would accept an HS256 token signed
 * with `DEFAULT_SVID_HMAC_SECRET` — an exported constant in this repository.
 * That made every SPIFFE id and audience forgeable by anyone who had read the
 * source. The guard added alongside these tests closes it; the test below is
 * what keeps it closed.
 *
 * The rest covers the boundaries a token has to survive: expiry (with skew),
 * issued-in-the-future, audience binding, a tampered payload, a truncated token,
 * and the production-secret policy that stops the dev default reaching prod.
 */
import { describe, expect, test } from "vitest";

import {
	DEFAULT_SVID_HMAC_SECRET,
	generateSvidIssuerKeys,
	mintJwtSvid,
	resolveSvidHmacSecret,
	spiffeIdForAgent,
	verifyJwtSvid,
} from "../src/crypto/jwt-svid.js";

const SPIFFE = "spiffe://hobo.local/agent/deployer";
const AUD = "database-access";
const SECRET = "test-hmac-secret-not-the-default";
const NOW = 1_800_000_000;

function mint(overrides: Partial<Parameters<typeof mintJwtSvid>[0]> = {}) {
	return mintJwtSvid({
		spiffeId: SPIFFE,
		audience: AUD,
		hmacSecret: SECRET,
		now: NOW,
		...overrides,
	});
}

function messageOf(fn: () => void): string {
	try {
		fn();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "<did not throw>";
}

describe("algorithm confusion (regression)", () => {
	test("an ES256-configured verifier refuses an HS256 token", () => {
		// The forgery this guard exists for. `DEFAULT_SVID_HMAC_SECRET` is an
		// exported constant, so anyone can produce this token; before the guard,
		// a verifier holding only a public key accepted it and the attacker
		// chose their own `sub` and `aud`.
		const keys = generateSvidIssuerKeys();
		const forged = mintJwtSvid({
			spiffeId: "spiffe://hobo.local/agent/attacker",
			audience: AUD,
			hmacSecret: DEFAULT_SVID_HMAC_SECRET,
			allowDefaultSecret: true,
			now: NOW,
		});
		expect(
			messageOf(() =>
				verifyJwtSvid({
					token: forged.token,
					audience: AUD,
					publicKey: keys.publicKey,
					now: NOW,
				}),
			),
		).toContain("algorithm mismatch");
	});

	test("the same forgery is refused whichever subject and audience it claims", () => {
		const keys = generateSvidIssuerKeys();
		for (const spiffeId of [
			"spiffe://hobo.local/agent/admin",
			"spiffe://other-domain/workload/root",
		]) {
			const forged = mintJwtSvid({
				spiffeId,
				audience: ["production-access", "*"],
				hmacSecret: DEFAULT_SVID_HMAC_SECRET,
				allowDefaultSecret: true,
				now: NOW,
			});
			expect(() =>
				verifyJwtSvid({
					token: forged.token,
					audience: "production-access",
					publicKey: keys.publicKey,
					now: NOW,
				}),
			).toThrow(/algorithm mismatch/);
		}
	});

	test("a caller that configures both a key and a secret may still verify HS256", () => {
		// The guard keys off the *absence* of an hmacSecret, so a deployment
		// running both issuers during a migration is not broken by it.
		const keys = generateSvidIssuerKeys();
		const token = mint().token;
		expect(() =>
			verifyJwtSvid({
				token,
				audience: AUD,
				publicKey: keys.publicKey,
				hmacSecret: SECRET,
				now: NOW,
			}),
		).not.toThrow();
	});

	test("an HS256-only verifier is unaffected", () => {
		// The common local path must keep working; the guard only fires when a
		// public key was configured.
		const token = mint().token;
		expect(() =>
			verifyJwtSvid({ token, audience: AUD, hmacSecret: SECRET, now: NOW }),
		).not.toThrow();
	});

	test("an unsupported algorithm is refused rather than defaulted", () => {
		// `alg: none` is the other classic. Falling through to any verification
		// path here would accept an unsigned token.
		const token = mint().token;
		const [, payload, sig] = token.split(".");
		const noneHeader = Buffer.from(
			JSON.stringify({ alg: "none", typ: "JWT" }),
		).toString("base64url");
		expect(
			messageOf(() =>
				verifyJwtSvid({
					token: `${noneHeader}.${payload}.${sig}`,
					audience: AUD,
					hmacSecret: SECRET,
					now: NOW,
				}),
			),
		).toContain("unsupported alg");
	});
});

describe("minting", () => {
	test("a non-SPIFFE subject is refused", () => {
		// The subject is the identity. A bare string that is not a SPIFFE id
		// would produce a document nothing can authorise against.
		expect(messageOf(() => mint({ spiffeId: "user:alice" }))).toContain(
			"spiffe://",
		);
	});

	test("the default TTL is fifteen minutes", () => {
		// Short-lived is half the security property; a long default would make
		// a leaked token useful for hours.
		const minted = mint();
		expect(minted.claims.exp - minted.claims.iat).toBe(900);
	});

	test("an explicit TTL is honoured", () => {
		expect(mint({ ttlSeconds: 60 }).claims.exp - NOW).toBe(60);
	});

	test("a single audience is normalised to a list", () => {
		// Verification reads `aud` as an array unconditionally.
		expect(mint().claims.aud).toEqual([AUD]);
	});

	test("multiple audiences are preserved in order", () => {
		expect(mint({ audience: ["a", "b"] }).claims.aud).toEqual(["a", "b"]);
	});

	test("every token gets a distinct jti", () => {
		// The jti is what makes a token individually revocable and replay-
		// detectable; a constant one would collapse every session into one.
		const ids = new Set(Array.from({ length: 20 }, () => mint().claims.jti));
		expect(ids.size).toBe(20);
	});

	test("an issuer is recorded when given and omitted otherwise", () => {
		expect(mint({ issuer: "hobo:local" }).claims.iss).toBe("hobo:local");
		expect("iss" in mint().claims).toBe(false);
	});

	test("the minted token has three segments", () => {
		expect(mint().token.split(".")).toHaveLength(3);
	});
});

describe("verification boundaries", () => {
	test("a valid token round-trips", () => {
		const minted = mint();
		const claims = verifyJwtSvid({
			token: minted.token,
			audience: AUD,
			hmacSecret: SECRET,
			now: NOW,
		});
		expect(claims.sub).toBe(SPIFFE);
		expect(claims.aud).toEqual([AUD]);
	});

	test("an expired token is refused", () => {
		const minted = mint({ ttlSeconds: 60 });
		expect(
			messageOf(() =>
				verifyJwtSvid({
					token: minted.token,
					audience: AUD,
					hmacSecret: SECRET,
					now: NOW + 200,
				}),
			),
		).toContain("expired");
	});

	test("clock skew is allowed but bounded", () => {
		// A token just past expiry is accepted within the skew window, because
		// clocks disagree; well past it is not, or the TTL would be advisory.
		const minted = mint({ ttlSeconds: 60 });
		expect(() =>
			verifyJwtSvid({
				token: minted.token,
				audience: AUD,
				hmacSecret: SECRET,
				now: NOW + 90,
			}),
		).not.toThrow();
		expect(() =>
			verifyJwtSvid({
				token: minted.token,
				audience: AUD,
				hmacSecret: SECRET,
				now: NOW + 200,
			}),
		).toThrow(/expired/);
	});

	test("the skew window is configurable", () => {
		const minted = mint({ ttlSeconds: 60 });
		expect(() =>
			verifyJwtSvid({
				token: minted.token,
				audience: AUD,
				hmacSecret: SECRET,
				now: NOW + 90,
				maxClockSkewSeconds: 0,
			}),
		).toThrow(/expired/);
	});

	test("a token issued in the future is refused", () => {
		// Guards against a clock-skewed or deliberately post-dated issuer
		// minting credentials that become valid later.
		const minted = mint({ now: NOW + 10_000 });
		expect(
			messageOf(() =>
				verifyJwtSvid({
					token: minted.token,
					audience: AUD,
					hmacSecret: SECRET,
					now: NOW,
				}),
			),
		).toContain("future");
	});

	test("the wrong audience is refused", () => {
		// Audience binding is what stops a token minted for one service being
		// replayed against another.
		expect(
			messageOf(() =>
				verifyJwtSvid({
					token: mint().token,
					audience: "some-other-service",
					hmacSecret: SECRET,
					now: NOW,
				}),
			),
		).toContain("audience");
	});

	test("any one of several audiences satisfies verification", () => {
		const minted = mint({ audience: ["a", "b", "c"] });
		expect(() =>
			verifyJwtSvid({
				token: minted.token,
				audience: "b",
				hmacSecret: SECRET,
				now: NOW,
			}),
		).not.toThrow();
	});

	test("a token signed with a different secret is refused", () => {
		expect(
			messageOf(() =>
				verifyJwtSvid({
					token: mint().token,
					audience: AUD,
					hmacSecret: "a-completely-different-secret",
					now: NOW,
				}),
			),
		).toContain("signature invalid");
	});

	test("a tampered payload is refused", () => {
		// The signature covers header and payload, so rewriting the subject to
		// escalate must invalidate it.
		const minted = mint();
		const [header, , sig] = minted.token.split(".");
		const escalated = Buffer.from(
			JSON.stringify({
				...minted.claims,
				sub: "spiffe://hobo.local/agent/root",
			}),
		).toString("base64url");
		expect(
			messageOf(() =>
				verifyJwtSvid({
					token: `${header}.${escalated}.${sig}`,
					audience: AUD,
					hmacSecret: SECRET,
					now: NOW,
				}),
			),
		).toContain("signature invalid");
	});

	test("a malformed token is refused before anything is parsed", () => {
		for (const token of ["", "a", "a.b", "a.b.c.d"]) {
			expect(
				messageOf(() =>
					verifyJwtSvid({ token, audience: AUD, hmacSecret: SECRET, now: NOW }),
				),
			).toContain("malformed");
		}
	});

	test("a non-SPIFFE subject is refused at verification too", () => {
		// Defence in depth: the mint refuses these, but a token from any other
		// issuer has to be refused on the way in as well.
		const minted = mint();
		const [header, , sig] = minted.token.split(".");
		const payload = Buffer.from(
			JSON.stringify({ ...minted.claims, sub: "user:alice" }),
		).toString("base64url");
		expect(
			messageOf(() =>
				verifyJwtSvid({
					token: `${header}.${payload}.${sig}`,
					audience: AUD,
					hmacSecret: SECRET,
					now: NOW,
				}),
			),
		).toContain("spiffe id");
	});

	test("a non-numeric exp is refused rather than treated as absent", () => {
		// A token whose expiry is missing or a string must not be read as
		// "never expires".
		const minted = mint();
		const [header, , sig] = minted.token.split(".");
		for (const exp of [undefined, "9999999999", null]) {
			const payload = Buffer.from(
				JSON.stringify({ ...minted.claims, exp }),
			).toString("base64url");
			expect(
				messageOf(() =>
					verifyJwtSvid({
						token: `${header}.${payload}.${sig}`,
						audience: AUD,
						hmacSecret: SECRET,
						now: NOW,
					}),
				),
			).toContain("expired");
		}
	});
});

describe("ES256", () => {
	test("a key-signed token round-trips", () => {
		const keys = generateSvidIssuerKeys();
		const minted = mint({ privateKey: keys.privateKey });
		const claims = verifyJwtSvid({
			token: minted.token,
			audience: AUD,
			publicKey: keys.publicKey,
			now: NOW,
		});
		expect(claims.sub).toBe(SPIFFE);
	});

	test("a token from another issuer's key is refused", () => {
		// The point of asymmetric issuance: only the holder of the private key
		// can mint, and a second key pair must not be interchangeable.
		const mine = generateSvidIssuerKeys();
		const theirs = generateSvidIssuerKeys();
		const minted = mint({ privateKey: theirs.privateKey });
		expect(
			messageOf(() =>
				verifyJwtSvid({
					token: minted.token,
					audience: AUD,
					publicKey: mine.publicKey,
					now: NOW,
				}),
			),
		).toContain("signature invalid");
	});

	test("verifying ES256 without a public key is refused", () => {
		// Falling back to the HMAC path here would be the same confusion bug in
		// the other direction.
		const keys = generateSvidIssuerKeys();
		const minted = mint({ privateKey: keys.privateKey });
		expect(
			messageOf(() =>
				verifyJwtSvid({ token: minted.token, audience: AUD, now: NOW }),
			),
		).toContain("publicKey required");
	});

	test("JWK-shaped keys work on both sides", () => {
		// Keys arrive as JWKs from a JWKS endpoint, not as KeyObjects.
		const keys = generateSvidIssuerKeys();
		const minted = mint({ privateKey: keys.privateJwk });
		expect(() =>
			verifyJwtSvid({
				token: minted.token,
				audience: AUD,
				publicKey: keys.publicJwk,
				now: NOW,
			}),
		).not.toThrow();
	});

	test("a kid is carried in the header when supplied", () => {
		// A verifier with several trusted keys selects on the kid; without it,
		// key rotation means trying every key.
		const keys = generateSvidIssuerKeys();
		const minted = mint({ privateKey: keys.privateKey, kid: "issuer-2026-01" });
		const header = JSON.parse(
			Buffer.from(minted.token.split(".")[0] ?? "", "base64").toString("utf8"),
		);
		expect(header.kid).toBe("issuer-2026-01");
		expect(header.alg).toBe("ES256");
	});

	test("the header omits kid when none is given", () => {
		const keys = generateSvidIssuerKeys();
		const minted = mint({ privateKey: keys.privateKey });
		const header = JSON.parse(
			Buffer.from(minted.token.split(".")[0] ?? "", "base64").toString("utf8"),
		);
		expect("kid" in header).toBe(false);
	});

	test("a tampered ES256 payload is refused", () => {
		const keys = generateSvidIssuerKeys();
		const minted = mint({ privateKey: keys.privateKey });
		const [header, , sig] = minted.token.split(".");
		const payload = Buffer.from(
			JSON.stringify({
				...minted.claims,
				sub: "spiffe://hobo.local/agent/root",
			}),
		).toString("base64url");
		expect(() =>
			verifyJwtSvid({
				token: `${header}.${payload}.${sig}`,
				audience: AUD,
				publicKey: keys.publicKey,
				now: NOW,
			}),
		).toThrow(/signature invalid/);
	});

	test("generated key pairs are distinct", () => {
		const a = generateSvidIssuerKeys();
		const b = generateSvidIssuerKeys();
		expect(a.publicJwk.x).not.toBe(b.publicJwk.x);
	});

	test("the generated public JWK is a P-256 EC key", () => {
		const keys = generateSvidIssuerKeys();
		expect(keys.publicJwk.kty).toBe("EC");
		expect(keys.publicJwk.crv).toBe("P-256");
		// A public JWK must not carry the private component.
		expect("d" in keys.publicJwk).toBe(false);
		expect(keys.privateJwk.d).toBeDefined();
	});
});

describe("resolveSvidHmacSecret", () => {
	test("an explicit secret is used as given", () => {
		expect(
			resolveSvidHmacSecret({
				hmacSecret: "explicit",
				env: { HOBO_SVID_HMAC_SECRET: "from-env" },
			}),
		).toBe("explicit");
	});

	test("never reads the secret from the environment", () => {
		expect(
			resolveSvidHmacSecret({ env: { HOBO_SVID_HMAC_SECRET: "from-env" } }),
		).toBe(DEFAULT_SVID_HMAC_SECRET);
		expect(
			messageOf(() =>
				resolveSvidHmacSecret({
					env: { NODE_ENV: "production", HOBO_SVID_HMAC_SECRET: "from-env" },
				}),
			),
		).toContain("owner://HOBO_SVID_HMAC_SECRET");
	});

	test("an empty secret is treated as absent", () => {
		// An unset variable often arrives as an empty string; signing with it
		// would be signing with no key at all.
		expect(resolveSvidHmacSecret({ hmacSecret: "", env: {} })).toBe(
			DEFAULT_SVID_HMAC_SECRET,
		);
	});

	test("development falls back to the documented default", () => {
		expect(resolveSvidHmacSecret({ env: {} })).toBe(DEFAULT_SVID_HMAC_SECRET);
		expect(resolveSvidHmacSecret({ env: { NODE_ENV: "development" } })).toBe(
			DEFAULT_SVID_HMAC_SECRET,
		);
	});

	test("production with no secret configured is refused", () => {
		// The whole point: production must not silently run on a published
		// constant. Failing to start is the correct outcome.
		for (const env of [
			{ NODE_ENV: "production" },
			{ HOBO_ENV: "prod" },
			{ HOBO_ENV: "production" },
		]) {
			expect(messageOf(() => resolveSvidHmacSecret({ env }))).toContain(
				"required outside development",
			);
		}
	});

	test("production explicitly configured with the default secret is refused", () => {
		// Naming the dev constant in production config is the same mistake spelled
		// differently, and gets the same refusal — with a message that says what
		// to do instead.
		const message = messageOf(() =>
			resolveSvidHmacSecret({
				hmacSecret: DEFAULT_SVID_HMAC_SECRET,
				env: { NODE_ENV: "production" },
			}),
		);
		expect(message).toContain("not allowed in production");
		expect(message).toContain("owner://HOBO_SVID_HMAC_SECRET");
	});

	test("an explicit opt-in allows the default secret even in production", () => {
		// The escape hatch exists for tests; it has to be explicit rather than
		// inferable from the environment.
		expect(
			resolveSvidHmacSecret({
				hmacSecret: DEFAULT_SVID_HMAC_SECRET,
				env: { NODE_ENV: "production" },
				allowDefaultSecret: true,
			}),
		).toBe(DEFAULT_SVID_HMAC_SECRET);
	});

	test("a real secret is accepted in production", () => {
		expect(
			resolveSvidHmacSecret({
				hmacSecret: "a-strong-production-secret",
				env: { NODE_ENV: "production" },
			}),
		).toBe("a-strong-production-secret");
	});

	test("the production check is case-insensitive", () => {
		expect(() =>
			resolveSvidHmacSecret({ env: { NODE_ENV: "PRODUCTION" } }),
		).toThrow();
	});

	test("a non-production NODE_ENV does not trigger the guard", () => {
		for (const nodeEnv of ["test", "staging", "dev", ""]) {
			expect(() =>
				resolveSvidHmacSecret({ env: { NODE_ENV: nodeEnv } }),
			).not.toThrow();
		}
	});
});

describe("spiffeIdForAgent", () => {
	test("a bare agent id becomes a namespaced SPIFFE id", () => {
		expect(spiffeIdForAgent("deployer")).toBe(
			"spiffe://hobo.local/agent/deployer",
		);
	});

	test("an agent: prefix is stripped", () => {
		expect(spiffeIdForAgent("agent:deployer")).toBe(
			"spiffe://hobo.local/agent/deployer",
		);
	});

	test("an already-SPIFFE id in the trust domain is preserved", () => {
		// Re-wrapping would produce `spiffe://hobo.local/agent/hobo.local%2F...`
		// and break every comparison against the original.
		expect(spiffeIdForAgent("spiffe://hobo.local/agent/deployer")).toBe(
			"spiffe://hobo.local/agent/deployer",
		);
	});

	test("a custom trust domain is honoured", () => {
		expect(spiffeIdForAgent("deployer", "prod.example")).toBe(
			"spiffe://prod.example/agent/deployer",
		);
	});

	test("an id from another trust domain is re-namespaced, not adopted", () => {
		// This one matters: an id naming a *different* trust domain must not be
		// passed through as if it belonged to ours. It is escaped into a path
		// segment under our domain instead.
		const result = spiffeIdForAgent(
			"spiffe://other.example/agent/x",
			"hobo.local",
		);
		expect(result.startsWith("spiffe://hobo.local/agent/")).toBe(true);
		expect(result).not.toBe("spiffe://other.example/agent/x");
	});

	test("path-separator characters in an id are percent-encoded", () => {
		// Otherwise an agent id could inject extra path segments and impersonate
		// a different workload.
		const result = spiffeIdForAgent("../../admin", "hobo.local");
		expect(result.startsWith("spiffe://hobo.local/agent/")).toBe(true);
		expect(result).not.toContain("/../");
	});

	test("the result is always a well-formed SPIFFE id the mint will accept", () => {
		for (const id of ["a", "agent:b", "with space", "with/slash", "üñî"]) {
			const spiffeId = spiffeIdForAgent(id);
			expect(spiffeId.startsWith("spiffe://")).toBe(true);
			expect(() =>
				mintJwtSvid({
					spiffeId,
					audience: AUD,
					hmacSecret: SECRET,
					now: NOW,
				}),
			).not.toThrow();
		}
	});
});
