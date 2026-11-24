// DPoP (RFC 9449) and JWK thumbprint (RFC 7638) units for the agent identity
// boundary. Replay and key mismatch are refused (WP11 Accept).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	createDpopProof,
	createDpopProofVerifier,
	createJournalReplayStore,
	generateAgentKey,
	jwkThumbprint,
	parsePublicJwk,
	verifyDpopProof,
} from "../../src/agent/index.js";
import { createClock, createFakeStore, TENANT } from "../feed/fakes.js";

const URL_REFRESH = "https://station.test/v1/cd/svid/refresh";

describe("JWK thumbprint (RFC 7638)", () => {
	it("matches the RFC 7638 §3.1 example for an RSA key shape over EC members", () => {
		// RFC 7638 orders required members lexicographically with no whitespace.
		const jwk = parsePublicJwk({
			kty: "EC",
			crv: "P-256",
			x: "AAAA",
			y: "BBBB",
		});
		expect(jwk.ok).toBe(true);
		if (!jwk.ok) return;
		const expected = createHash("sha256")
			.update('{"crv":"P-256","kty":"EC","x":"AAAA","y":"BBBB"}')
			.digest("base64url");
		expect(jwkThumbprint(jwk.value)).toBe(expected);
	});

	it("refuses private key material and unsupported key types", () => {
		const key = generateAgentKey("ES256");
		const leaked = parsePublicJwk(key.privateJwk);
		expect(leaked.ok).toBe(false);
		if (!leaked.ok) expect(leaked.reasons[0]?.code).toBe("jwk-invalid");
		const rsa = parsePublicJwk({ kty: "RSA", n: "x", e: "AQAB" });
		expect(rsa.ok).toBe(false);
	});
});

describe("DPoP proofs", () => {
	it("does not echo untrusted proof fields in verification refusals", () => {
		const marker = "synthetic-private-proof.invalid";
		const key = generateAgentKey("ES256");
		const expectation = {
			method: "POST",
			url: URL_REFRESH,
			nowMs: 1_000_000,
			skewMs: 60_000,
		};
		const make = (method: string, url: string) =>
			createDpopProof({
				privateJwk: key.privateJwk,
				method,
				url,
				iatSeconds: 1000,
				jti: "fixture",
			});
		const valid = make("POST", URL_REFRESH);
		const [head, payload, signature] = valid.split(".");
		const header = JSON.parse(
			Buffer.from(head ?? "", "base64url").toString("utf8"),
		);
		const altered = Buffer.from(
			JSON.stringify({ ...header, alg: marker }),
		).toString("base64url");
		const results = [
			verifyDpopProof(make(marker, URL_REFRESH), expectation),
			verifyDpopProof(make("POST", `https://${marker}/wrong`), expectation),
			verifyDpopProof(`${altered}.${payload}.${signature}`, expectation),
			parsePublicJwk({ kty: marker, crv: marker, x: "AAAA" }),
		];
		expect(
			results.map((result) => (result.ok ? "ok" : result.reasons[0]?.code)),
		).toEqual([
			"dpop-method-mismatch",
			"dpop-url-mismatch",
			"dpop-invalid",
			"jwk-invalid",
		]);
		expect(JSON.stringify(results)).not.toContain(marker);
	});

	for (const alg of ["ES256", "EdDSA"] as const) {
		it(`round-trips an ${alg} proof bound to the key thumbprint`, () => {
			const key = generateAgentKey(alg);
			const proof = createDpopProof({
				privateJwk: key.privateJwk,
				method: "POST",
				url: URL_REFRESH,
				iatSeconds: 1000,
				jti: "j-1",
			});
			const verified = verifyDpopProof(proof, {
				method: "POST",
				url: URL_REFRESH,
				nowMs: 1_000_000,
				skewMs: 60_000,
			});
			expect(verified.ok).toBe(true);
			if (verified.ok) {
				expect(verified.value.jkt).toBe(key.thumbprint);
				expect(verified.value.jti).toBe("j-1");
			}
		});
	}

	it("binds ath to the access token and refuses a mismatch", () => {
		const key = generateAgentKey("ES256");
		const proof = createDpopProof({
			privateJwk: key.privateJwk,
			method: "GET",
			url: "https://station.test/v1/cd/feed?camp=a",
			iatSeconds: 1000,
			jti: "j",
			accessToken: "svid-a",
		});
		expect(
			verifyDpopProof(proof, {
				method: "GET",
				url: "/v1/cd/feed",
				nowMs: 1_000_000,
				skewMs: 60_000,
				accessToken: "svid-a",
			}).ok,
		).toBe(true);
		const wrong = verifyDpopProof(proof, {
			method: "GET",
			url: "/v1/cd/feed",
			nowMs: 1_000_000,
			skewMs: 60_000,
			accessToken: "svid-b",
		});
		expect(wrong.ok ? "" : wrong.reasons[0]?.code).toBe("dpop-ath-mismatch");
	});

	it("refuses wrong method, wrong URL, stale iat and a tampered signature", () => {
		const key = generateAgentKey("ES256");
		const proof = createDpopProof({
			privateJwk: key.privateJwk,
			method: "POST",
			url: URL_REFRESH,
			iatSeconds: 1000,
			jti: "j",
		});
		const code = (r: ReturnType<typeof verifyDpopProof>) =>
			r.ok ? "ok" : r.reasons[0]?.code;
		const wrongScheme = createDpopProof({
			privateJwk: key.privateJwk,
			method: "POST",
			url: "http://station.test/v1/cd/svid/refresh",
			iatSeconds: 1000,
			jti: "wrong-scheme",
		});
		expect(
			code(
				verifyDpopProof(wrongScheme, {
					method: "POST",
					url: URL_REFRESH,
					nowMs: 1_000_000,
					skewMs: 60_000,
				}),
			),
		).toBe("dpop-url-mismatch");
		expect(
			code(
				verifyDpopProof(proof, {
					method: "GET",
					url: URL_REFRESH,
					nowMs: 1_000_000,
					skewMs: 60_000,
				}),
			),
		).toBe("dpop-method-mismatch");
		expect(
			code(
				verifyDpopProof(proof, {
					method: "POST",
					url: "/v1/cd/leases",
					nowMs: 1_000_000,
					skewMs: 60_000,
				}),
			),
		).toBe("dpop-url-mismatch");
		expect(
			code(
				verifyDpopProof(proof, {
					method: "POST",
					url: URL_REFRESH,
					nowMs: 1_061_000,
					skewMs: 60_000,
				}),
			),
		).toBe("dpop-stale");
		expect(
			code(
				verifyDpopProof(proof, {
					method: "POST",
					url: URL_REFRESH,
					nowMs: 939_000,
					skewMs: 60_000,
				}),
			),
		).toBe("dpop-stale");
		const [h, p, s] = proof.split(".");
		const tampered = `${h}.${p}.${s?.startsWith("A") ? `B${s.slice(1)}` : `A${s?.slice(1)}`}`;
		expect(
			code(
				verifyDpopProof(tampered, {
					method: "POST",
					url: URL_REFRESH,
					nowMs: 1_000_000,
					skewMs: 60_000,
				}),
			),
		).toBe("dpop-invalid");
		expect(
			code(
				verifyDpopProof("not.a.jwt", {
					method: "POST",
					url: URL_REFRESH,
					nowMs: 1_000_000,
					skewMs: 60_000,
				}),
			),
		).toBe("dpop-invalid");
	});

	it("refuses a proof whose typ is not dpop+jwt or whose header carries private material", () => {
		const key = generateAgentKey("ES256");
		const proof = createDpopProof({
			privateJwk: key.privateJwk,
			method: "POST",
			url: URL_REFRESH,
			iatSeconds: 1000,
			jti: "j",
		});
		const [h, p, s] = proof.split(".");
		const header = JSON.parse(
			Buffer.from(h ?? "", "base64url").toString("utf8"),
		);
		const wrongTyp = Buffer.from(
			JSON.stringify({ ...header, typ: "JWT" }),
		).toString("base64url");
		const r = verifyDpopProof(`${wrongTyp}.${p}.${s}`, {
			method: "POST",
			url: URL_REFRESH,
			nowMs: 1_000_000,
			skewMs: 60_000,
		});
		expect(r.ok ? "" : r.reasons[0]?.code).toBe("dpop-invalid");
	});
});

describe("replay verification failure", () => {
	it("redacts a replay-store error after verifying a valid proof", async () => {
		const key = generateAgentKey("ES256");
		const proof = createDpopProof({
			privateJwk: key.privateJwk,
			method: "POST",
			url: URL_REFRESH,
			iatSeconds: 1000,
			jti: "fixture",
		});
		const verifier = createDpopProofVerifier({
			replay: {
				claim: async () => {
					throw new Error("synthetic-private-journal.invalid");
				},
			},
			skewMs: 60_000,
		});
		const out = await verifier.verify(proof, {
			reconcilerId: "fixture",
			method: "POST",
			url: URL_REFRESH,
			nowMs: 1_000_000,
		});
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reasons[0]?.code).toBe("store-unavailable");
		expect(JSON.stringify(out)).not.toContain(
			"synthetic-private-journal.invalid",
		);
	});
});

describe("durable jti replay store", () => {
	it("accepts a jti once per reconciler and refuses a replay, durably across instances", async () => {
		const clock = createClock();
		const store = createFakeStore(clock);
		const a = createJournalReplayStore({
			store,
			tenant: TENANT,
			skewMs: 60_000,
		});
		expect(
			await a.claim({ reconcilerId: "agent-1", jti: "j-1", iatSeconds: 1000 }),
		).toBe(true);
		expect(
			await a.claim({ reconcilerId: "agent-1", jti: "j-1", iatSeconds: 1000 }),
		).toBe(false);
		// A second Station replica over the same journal sees the replay.
		const b = createJournalReplayStore({
			store,
			tenant: TENANT,
			skewMs: 60_000,
		});
		expect(
			await b.claim({ reconcilerId: "agent-1", jti: "j-1", iatSeconds: 1000 }),
		).toBe(false);
		expect(
			await b.claim({ reconcilerId: "agent-2", jti: "j-1", iatSeconds: 1000 }),
		).toBe(true);
	});

	it("is concurrency-safe: two simultaneous claims of one jti admit exactly one", async () => {
		const store = createFakeStore(createClock());
		const replay = createJournalReplayStore({
			store,
			tenant: TENANT,
			skewMs: 60_000,
		});
		const results = await Promise.all([
			replay.claim({ reconcilerId: "agent-1", jti: "same", iatSeconds: 5 }),
			replay.claim({ reconcilerId: "agent-1", jti: "same", iatSeconds: 5 }),
			replay.claim({ reconcilerId: "agent-1", jti: "other", iatSeconds: 5 }),
		]);
		expect(results.filter((r) => r)).toHaveLength(2);
	});
});
