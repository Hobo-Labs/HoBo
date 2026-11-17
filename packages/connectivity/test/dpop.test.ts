import { createHash, sign } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
	accessTokenHash,
	createDpopJtiCache,
	exportDpopPrivateJwk,
	generateDpopKeyPair,
	importDpopKeyPair,
	mintDpopProof,
	verifyDpopProof,
} from "../src/crypto/dpop.js";
import { type JsonValue, parseJsonObject } from "../src/json.js";

const HTM = "POST";
const HTU = "https://api.example.test/v1/deploy";
const TOKEN = "access-token-abc";
const NOW = 1_800_000_000;

const keys = generateDpopKeyPair("kid-1");

function proof(overrides: Partial<Parameters<typeof mintDpopProof>[0]> = {}) {
	return mintDpopProof({
		keyPair: keys,
		htm: HTM,
		htu: HTU,
		accessToken: TOKEN,
		now: NOW,
		...overrides,
	});
}

function verify(
	overrides: Partial<Parameters<typeof verifyDpopProof>[0]> = {},
) {
	return verifyDpopProof({
		proof: proof(),
		htm: HTM,
		htu: HTU,
		accessToken: TOKEN,
		now: NOW,
		...overrides,
	});
}

function messageOf<T>(fn: () => T): string {
	try {
		fn();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "<did not throw>";
}

function tamper(
	original: string,
	edit: {
		header?: (
			h: Record<string, JsonValue | undefined>,
		) => Record<string, JsonValue | undefined>;
		payload?: (
			p: Record<string, JsonValue | undefined>,
		) => Record<string, JsonValue | undefined>;
	},
): string {
	const [h, p, s] = original.split(".") as [string, string, string];
	const header = parseJsonObject(Buffer.from(h, "base64url").toString("utf8"));
	const payload = parseJsonObject(Buffer.from(p, "base64url").toString("utf8"));
	const nextHeader = edit.header ? edit.header(header) : header;
	const nextPayload = edit.payload ? edit.payload(payload) : payload;
	return [
		Buffer.from(JSON.stringify(nextHeader)).toString("base64url"),
		Buffer.from(JSON.stringify(nextPayload)).toString("base64url"),
		s,
	].join(".");
}

describe("a well-formed proof", () => {
	test("round-trips and reports its bindings", () => {
		const verified = verify();
		expect(verified.htm).toBe("POST");
		expect(verified.htu).toBe(HTU);
		expect(verified.ath).toBe(accessTokenHash(TOKEN));
		expect(verified.kid).toBe("kid-1");
		expect(verified.jti).toHaveLength(32);
	});

	test("the returned jwk is the public key the proof carried", () => {
		const verified = verify();
		expect(verified.jwk.kty).toBe("EC");
		expect(verified.jwk.crv).toBe("P-256");
		expect(verified.jwk.x).toBe(keys.jwkPublic.x);
		expect(verified.jwk.y).toBe(keys.jwkPublic.y);
	});

	test("every proof carries a fresh jti", () => {
		const ids = new Set(
			Array.from(
				{ length: 20 },
				() =>
					verifyDpopProof({
						proof: proof(),
						htm: HTM,
						htu: HTU,
						accessToken: TOKEN,
						now: NOW,
					}).jti,
			),
		);
		expect(ids.size).toBe(20);
	});

	test("the method is normalised to upper case on both sides", () => {
		expect(() =>
			verifyDpopProof({
				proof: proof({ htm: "post" }),
				htm: "POST",
				htu: HTU,
				accessToken: TOKEN,
				now: NOW,
			}),
		).not.toThrow();
	});

	test("extra claims ride along without disturbing verification", () => {
		expect(() =>
			verifyDpopProof({
				proof: proof({ extra: { nonce: "server-nonce" } }),
				htm: HTM,
				htu: HTU,
				accessToken: TOKEN,
				now: NOW,
			}),
		).not.toThrow();
	});
});

describe("access-token binding (ath)", () => {
	test("a proof minted for one token does not verify against another", () => {
		expect(
			messageOf(() =>
				verifyDpopProof({
					proof: proof({ accessToken: "some-other-token" }),
					htm: HTM,
					htu: HTU,
					accessToken: TOKEN,
					now: NOW,
				}),
			),
		).toContain("ath mismatch");
	});

	test("a proof with no ath at all is refused", () => {
		expect(
			messageOf(() =>
				verify({
					proof: tamper(proof(), {
						payload: ({ ath, ...rest }) => {
							void ath;
							return rest;
						},
					}),
				}),
			),
		).toContain("ath mismatch");
	});

	test("the hash is over the token bytes, not a truncation", () => {
		expect(accessTokenHash("token-aaaa")).not.toBe(
			accessTokenHash("token-aaab"),
		);
		expect(accessTokenHash(TOKEN)).toBe(accessTokenHash(TOKEN));
	});

	test("the hash is base64url with no padding", () => {
		expect(accessTokenHash(TOKEN)).toMatch(/^[A-Za-z0-9_-]+$/);
	});
});

describe("method and URL binding (htm/htu)", () => {
	test("a proof for one method does not verify for another", () => {
		expect(
			messageOf(() =>
				verifyDpopProof({
					proof: proof({ htm: "GET" }),
					htm: "DELETE",
					htu: HTU,
					accessToken: TOKEN,
					now: NOW,
				}),
			),
		).toContain("htm mismatch");
	});

	test("a proof for one URL does not verify for another", () => {
		expect(
			messageOf(() =>
				verifyDpopProof({
					proof: proof({ htu: "https://api.example.test/v1/status" }),
					htm: HTM,
					htu: HTU,
					accessToken: TOKEN,
					now: NOW,
				}),
			),
		).toContain("htu mismatch");
	});

	test("a proof with no htu is refused", () => {
		expect(
			messageOf(() =>
				verify({
					proof: tamper(proof(), {
						payload: ({ htu, ...rest }) => {
							void htu;
							return rest;
						},
					}),
				}),
			),
		).toContain("htu mismatch");
	});

	test("a fragment does not change the URL identity", () => {
		expect(() =>
			verifyDpopProof({
				proof: proof({ htu: `${HTU}#section` }),
				htm: HTM,
				htu: HTU,
				accessToken: TOKEN,
				now: NOW,
			}),
		).not.toThrow();
	});

	test("a default port does not change the URL identity", () => {
		expect(() =>
			verifyDpopProof({
				proof: proof({ htu: "https://api.example.test:443/v1/deploy" }),
				htm: HTM,
				htu: HTU,
				accessToken: TOKEN,
				now: NOW,
			}),
		).not.toThrow();
	});

	test("a non-default port does change the URL identity", () => {
		expect(
			messageOf(() =>
				verifyDpopProof({
					proof: proof({ htu: "https://api.example.test:8443/v1/deploy" }),
					htm: HTM,
					htu: HTU,
					accessToken: TOKEN,
					now: NOW,
				}),
			),
		).toContain("htu mismatch");
	});

	test("a trailing slash on a non-root path is ignored", () => {
		expect(() =>
			verifyDpopProof({
				proof: proof({ htu: `${HTU}/` }),
				htm: HTM,
				htu: HTU,
				accessToken: TOKEN,
				now: NOW,
			}),
		).not.toThrow();
	});

	test("the query string is part of the URL identity", () => {
		expect(
			messageOf(() =>
				verifyDpopProof({
					proof: proof({ htu: `${HTU}?force=true` }),
					htm: HTM,
					htu: HTU,
					accessToken: TOKEN,
					now: NOW,
				}),
			),
		).toContain("htu mismatch");
	});

	test("an unparseable URL falls back to a literal comparison", () => {
		expect(() =>
			verifyDpopProof({
				proof: proof({ htu: "not a url" }),
				htm: HTM,
				htu: "not a url",
				accessToken: TOKEN,
				now: NOW,
			}),
		).not.toThrow();
		expect(
			messageOf(() =>
				verifyDpopProof({
					proof: proof({ htu: "not a url" }),
					htm: HTM,
					htu: "also not a url",
					accessToken: TOKEN,
					now: NOW,
				}),
			),
		).toContain("htu mismatch");
	});
});

describe("freshness (iat) and replay (jti)", () => {
	test("a proof from too far in the past is refused", () => {
		expect(messageOf(() => verify({ now: NOW + 400 }))).toContain("skew");
	});

	test("a proof from too far in the future is refused", () => {
		expect(messageOf(() => verify({ now: NOW - 400 }))).toContain("skew");
	});

	test("a proof inside the window is accepted in both directions", () => {
		expect(() => verify({ now: NOW + 299 })).not.toThrow();
		expect(() => verify({ now: NOW - 299 })).not.toThrow();
	});

	test("the window is configurable", () => {
		expect(() => verify({ now: NOW + 30, maxSkewSeconds: 10 })).toThrow(/skew/);
		expect(() => verify({ now: NOW + 30, maxSkewSeconds: 60 })).not.toThrow();
	});

	test("a non-numeric iat is refused rather than treated as absent", () => {
		expect(
			messageOf(() =>
				verify({
					proof: tamper(proof(), {
						payload: (p) => ({ ...p, iat: "1800000000" }),
					}),
				}),
			),
		).toContain("skew");
	});

	test("a proof with no jti is refused", () => {
		expect(
			messageOf(() =>
				verify({
					proof: tamper(proof(), {
						payload: ({ jti, ...rest }) => {
							void jti;
							return rest;
						},
					}),
				}),
			),
		).toContain("jti required");
	});

	test("an empty jti is refused", () => {
		expect(
			messageOf(() =>
				verify({
					proof: tamper(proof(), { payload: (p) => ({ ...p, jti: "" }) }),
				}),
			),
		).toContain("jti required");
	});

	test("replaying the same proof is refused when a cache is supplied", () => {
		const jtiCache = createDpopJtiCache({ now: () => NOW });
		const p = proof();
		expect(() =>
			verifyDpopProof({
				proof: p,
				htm: HTM,
				htu: HTU,
				accessToken: TOKEN,
				now: NOW,
				jtiCache,
			}),
		).not.toThrow();
		expect(
			messageOf(() =>
				verifyDpopProof({
					proof: p,
					htm: HTM,
					htu: HTU,
					accessToken: TOKEN,
					now: NOW,
					jtiCache,
				}),
			),
		).toContain("replay detected");
	});

	test("distinct proofs pass the same cache", () => {
		const jtiCache = createDpopJtiCache({ now: () => NOW });
		for (let i = 0; i < 5; i++) {
			expect(() =>
				verifyDpopProof({
					proof: proof(),
					htm: HTM,
					htu: HTU,
					accessToken: TOKEN,
					now: NOW,
					jtiCache,
				}),
			).not.toThrow();
		}
		expect(jtiCache.size).toBe(5);
	});

	test("without a cache a replay is not detected", () => {
		const p = proof();
		expect(() => verify({ proof: p })).not.toThrow();
		expect(() => verify({ proof: p })).not.toThrow();
	});
});

describe("the jti replay cache", () => {
	test("an entry expires after its TTL and the jti becomes usable again", () => {
		let clock = NOW;
		const cache = createDpopJtiCache({ ttlSeconds: 100, now: () => clock });
		cache.assertFresh("jti-1", NOW);
		expect(messageOf(() => cache.assertFresh("jti-1", NOW))).toContain(
			"replay",
		);
		clock = NOW + 101;
		expect(() => cache.assertFresh("jti-1", clock)).not.toThrow();
	});

	test("expired entries are swept rather than accumulating", () => {
		let clock = NOW;
		const cache = createDpopJtiCache({ ttlSeconds: 10, now: () => clock });
		for (let i = 0; i < 50; i++) cache.assertFresh(`jti-${i}`, clock);
		expect(cache.size).toBe(50);
		clock = NOW + 100;
		cache.assertFresh("jti-new", clock);
		expect(cache.size).toBe(1);
	});

	test("the expiry is measured from the later of iat and now", () => {
		let clock = NOW;
		const cache = createDpopJtiCache({ ttlSeconds: 100, now: () => clock });
		cache.assertFresh("jti-1", NOW + 50);
		clock = NOW + 120;
		expect(messageOf(() => cache.assertFresh("jti-1", clock))).toContain(
			"replay",
		);
	});

	test("distinct jtis do not collide", () => {
		const cache = createDpopJtiCache({ now: () => NOW });
		cache.assertFresh("a", NOW);
		expect(() => cache.assertFresh("b", NOW)).not.toThrow();
	});
});

describe("header integrity", () => {
	test("a proof that is not a three-segment JWT is refused", () => {
		for (const bad of ["", "a", "a.b", "a.b.c.d"]) {
			expect(messageOf(() => verify({ proof: bad }))).toContain("malformed");
		}
	});

	test("a wrong typ is refused", () => {
		expect(
			messageOf(() =>
				verify({
					proof: tamper(proof(), { header: (h) => ({ ...h, typ: "JWT" }) }),
				}),
			),
		).toContain("typ must be dpop+jwt");
	});

	test("an alg other than ES256 is refused", () => {
		for (const alg of ["HS256", "none", "RS256"]) {
			expect(
				messageOf(() =>
					verify({
						proof: tamper(proof(), { header: (h) => ({ ...h, alg }) }),
					}),
				),
			).toContain("alg must be ES256");
		}
	});

	test("a header with no embedded jwk is refused", () => {
		expect(
			messageOf(() =>
				verify({
					proof: tamper(proof(), {
						header: ({ jwk, ...rest }) => {
							void jwk;
							return rest;
						},
					}),
				}),
			),
		).toContain("EC P-256");
	});

	test("a jwk of the wrong type or curve is refused", () => {
		for (const jwk of [
			{ kty: "RSA", crv: "P-256", x: "a", y: "b" },
			{ kty: "EC", crv: "P-384", x: "a", y: "b" },
			{ kty: "EC", crv: "P-256", x: "a" },
			{ kty: "EC", crv: "P-256", y: "b" },
		]) {
			expect(
				messageOf(() =>
					verify({
						proof: tamper(proof(), { header: (h) => ({ ...h, jwk }) }),
					}),
				),
			).toContain("EC P-256");
		}
	});

	test("substituting an attacker's key invalidates the signature", () => {
		const attacker = generateDpopKeyPair("kid-evil");
		expect(
			messageOf(() =>
				verify({
					proof: tamper(proof(), {
						header: (h) => ({
							...h,
							jwk: {
								kty: "EC",
								crv: "P-256",
								x: attacker.jwkPublic.x,
								y: attacker.jwkPublic.y,
							},
						}),
					}),
				}),
			),
		).toContain("signature verification failed");
	});

	test("a tampered payload invalidates the signature", () => {
		expect(
			messageOf(() =>
				verify({
					proof: tamper(proof(), {
						payload: (p) => ({ ...p, jti: "a".repeat(32) }),
					}),
				}),
			),
		).toContain("signature verification failed");
	});

	test("a proof signed by another key does not verify", () => {
		const other = generateDpopKeyPair("kid-2");
		const theirs = mintDpopProof({
			keyPair: other,
			htm: HTM,
			htu: HTU,
			accessToken: TOKEN,
			now: NOW,
		});
		expect(() => verify({ proof: theirs })).not.toThrow();
		expect(verify({ proof: theirs }).jwk.x).not.toBe(keys.jwkPublic.x);
	});

	test("removing the kid from a signed header breaks the signature", () => {
		expect(
			messageOf(() =>
				verify({
					proof: tamper(proof(), {
						header: ({ kid, ...rest }) => {
							void kid;
							return rest;
						},
					}),
				}),
			),
		).toContain("signature verification failed");
	});

	test("a kid absent from a validly-signed header is derived from the key", () => {
		const header = {
			typ: "dpop+jwt",
			alg: "ES256",
			jwk: {
				kty: "EC",
				crv: "P-256",
				x: keys.jwkPublic.x,
				y: keys.jwkPublic.y,
			},
		};
		const payload = {
			htm: HTM,
			htu: HTU,
			iat: NOW,
			jti: "a".repeat(32),
			ath: accessTokenHash(TOKEN),
		};
		const signingInput = [
			Buffer.from(JSON.stringify(header)).toString("base64url"),
			Buffer.from(JSON.stringify(payload)).toString("base64url"),
		].join(".");
		const signature = sign("SHA256", Buffer.from(signingInput, "utf8"), {
			key: keys.privateKey,
			dsaEncoding: "ieee-p1363",
		}).toString("base64url");

		const verified = verify({ proof: `${signingInput}.${signature}` });
		expect(verified.jwk.kid).toBe(verified.kid);
		expect(verified.kid).toBe(
			createHash("sha256")
				.update(`${keys.jwkPublic.x}.${keys.jwkPublic.y}`)
				.digest("hex")
				.slice(0, 16),
		);
	});
});

describe("key handling", () => {
	test("a generated pair carries a P-256 public jwk", () => {
		const pair = generateDpopKeyPair("kid-x");
		expect(pair.jwkPublic.kty).toBe("EC");
		expect(pair.jwkPublic.crv).toBe("P-256");
		expect(pair.jwkPublic.kid).toBe("kid-x");
		expect(pair.jwkPublic.x).toBeTruthy();
		expect(pair.jwkPublic.y).toBeTruthy();
	});

	test("an omitted kid is derived deterministically from the key", () => {
		const pair = generateDpopKeyPair();
		expect(pair.kid).toHaveLength(16);
		const reimported = importDpopKeyPair({
			privateJwk: exportDpopPrivateJwk(pair),
		});
		expect(reimported.kid).toBe(pair.kid);
	});

	test("generated pairs are distinct", () => {
		expect(generateDpopKeyPair().jwkPublic.x).not.toBe(
			generateDpopKeyPair().jwkPublic.x,
		);
	});

	test("an exported private jwk round-trips and can sign", () => {
		const pair = generateDpopKeyPair("kid-rt");
		const reimported = importDpopKeyPair({
			privateJwk: exportDpopPrivateJwk(pair),
		});
		const p = mintDpopProof({
			keyPair: reimported,
			htm: HTM,
			htu: HTU,
			accessToken: TOKEN,
			now: NOW,
		});
		expect(
			verifyDpopProof({
				proof: p,
				htm: HTM,
				htu: HTU,
				accessToken: TOKEN,
				now: NOW,
			}).jwk.x,
		).toBe(pair.jwkPublic.x);
	});

	test("the exported jwk is labelled for signing with ES256", () => {
		const jwk = exportDpopPrivateJwk(generateDpopKeyPair("kid-y"));
		expect(jwk.alg).toBe("ES256");
		expect(jwk.use).toBe("sig");
		expect(jwk.kid).toBe("kid-y");
	});

	test("an explicit kid overrides the one in the imported jwk", () => {
		const pair = generateDpopKeyPair("kid-original");
		const reimported = importDpopKeyPair({
			privateJwk: exportDpopPrivateJwk(pair),
			kid: "kid-override",
		});
		expect(reimported.kid).toBe("kid-override");
	});

	test("a jwk carrying its own kid keeps it when none is supplied", () => {
		const pair = generateDpopKeyPair("kid-embedded");
		const reimported = importDpopKeyPair({
			privateJwk: exportDpopPrivateJwk(pair),
		});
		expect(reimported.kid).toBe("kid-embedded");
	});

	test("importing a non-EC key is refused", () => {
		expect(() =>
			importDpopKeyPair({
				privateJwk: { kty: "oct", k: "c2VjcmV0" },
			}),
		).toThrow();
	});
});
