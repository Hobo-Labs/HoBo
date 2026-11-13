import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { KeyAlgorithm } from "../../src/_generated/fleet_pb.js";
import { parseKeyId } from "../../src/ids.js";
import {
	generateDpopKey,
	jwkThumbprint,
	mintDpopProof,
	verifyDpopProof,
} from "../../src/keys/index.js";
import { decodeCompactJws } from "../../src/keys/jose.js";
import { createMemoryReplayStore } from "../../src/keys/replay.js";
import { generateSigningKey, memorySigner } from "../../src/keys/signers.js";
import type { ReplayStore } from "../../src/ports.js";

// RFC 9449 §4.1, the example DPoP proof (ES256), and its key's jkt (§6.1).
const RFC9449_PROOF =
	"eyJ0eXAiOiJkcG9wK2p3dCIsImFsZyI6IkVTMjU2IiwiandrIjp7Imt0eSI6IkVDIiwieCI6Imw4dEZyaHgtMzR0VjNoUklDUkRZOXpDa0RscEJoRjQyVVFVZldWQVdCRnMiLCJ5IjoiOVZFNGpmX09rX282NHpiVFRsY3VOSmFqSG10NnY5VERWclUwQ2R2R1JEQSIsImNydiI6IlAtMjU2In19.eyJqdGkiOiItQndDM0VTYzZhY2MybFRjIiwiaHRtIjoiUE9TVCIsImh0dSI6Imh0dHBzOi8vc2VydmVyLmV4YW1wbGUuY29tL3Rva2VuIiwiaWF0IjoxNTYyMjYyNjE2fQ.2-GxA6T8lP4vfrg8v-FdWP0A0zdrj8igiMLvqRMUvwnQg4PtFLbdLXiOSsX0x7NVY-FNyJK70nfbV37xRZT3Lg";
const RFC9449_IAT_MS = 1_562_262_616_000;
const RFC9449_JKT = "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I";

const NOW = Date.parse("2026-11-12T10:00:00Z");
const URL_ = "https://authority.fleet.test/v1/fleet/members/x/credentials";

function replay(): ReplayStore {
	return createMemoryReplayStore(() => NOW);
}

describe("verifyDpopProof: the RFC 9449 vector", () => {
	it("accepts the §4.1 example proof and reports its jkt", async () => {
		const result = await verifyDpopProof({
			proof: RFC9449_PROOF,
			htm: "POST",
			htu: "https://server.example.com/token",
			nowMs: RFC9449_IAT_MS + 1_000,
			replay: replay(),
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.jkt).toBe(RFC9449_JKT);
			expect(jwkThumbprint(result.value.jwk)).toBe(RFC9449_JKT);
		}
	});

	it("refuses the example proof replayed, for another method, URL or time", async () => {
		const store = createMemoryReplayStore(() => RFC9449_IAT_MS);
		const base = {
			proof: RFC9449_PROOF,
			htm: "POST",
			htu: "https://server.example.com/token",
			nowMs: RFC9449_IAT_MS,
		};
		expect((await verifyDpopProof({ ...base, replay: store })).ok).toBe(true);
		const replayed = await verifyDpopProof({ ...base, replay: store });
		expect(replayed.ok ? undefined : replayed.error.code).toBe(
			"proof-replayed",
		);
		for (const changed of [
			{ htm: "GET" },
			{ htu: "https://server.example.com/other" },
			{ htu: "https://evil.example.com/token" },
			{ nowMs: RFC9449_IAT_MS + 61_000 },
			{ nowMs: RFC9449_IAT_MS - 61_000 },
			{ accessToken: "an-access-token" },
		]) {
			const result = await verifyDpopProof({
				...base,
				...changed,
				replay: replay(),
			});
			expect(result.ok ? undefined : result.error.code).toBe("proof-invalid");
		}
	});
});

describe.each([
	["ES256", KeyAlgorithm.ES256],
	["EdDSA", KeyAlgorithm.EDDSA],
] as const)("mintDpopProof and verifyDpopProof (%s)", (_name, algorithm) => {
	const { privateKey, publicJwk } = generateSigningKey(algorithm);
	const signer = memorySigner(
		parseKeyId("dev_0123456789abcdef0123456789abcdef#sign"),
		privateKey,
	);

	it("round-trips with htm, htu (query and fragment removed), iat and a fresh jti", async () => {
		const proof = await mintDpopProof(signer, publicJwk, {
			htm: "POST",
			htu: `${URL_}?x=1#frag`,
			nowMs: NOW,
		});
		const decoded = decodeCompactJws(proof);
		expect(decoded?.header.typ).toBe("dpop+jwt");
		expect(decoded?.header.alg).toBe(
			algorithm === KeyAlgorithm.ES256 ? "ES256" : "EdDSA",
		);
		expect(decoded?.payload.htu).toBe(URL_);
		expect(decoded?.payload.iat).toBe(NOW / 1000);
		const again = decodeCompactJws(
			await mintDpopProof(signer, publicJwk, {
				htm: "POST",
				htu: URL_,
				nowMs: NOW,
			}),
		);
		expect(again?.payload.jti).not.toBe(decoded?.payload.jti);
		const result = await verifyDpopProof({
			proof,
			htm: "POST",
			htu: URL_,
			nowMs: NOW + 59_000,
			replay: replay(),
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.jkt).toBe(jwkThumbprint(publicJwk));
	});

	it("accepts a path-only expected htu on the same path", async () => {
		const proof = await mintDpopProof(signer, publicJwk, {
			htm: "GET",
			htu: URL_,
			nowMs: NOW,
		});
		const result = await verifyDpopProof({
			proof,
			htm: "GET",
			htu: "/v1/fleet/members/x/credentials",
			nowMs: NOW,
			replay: replay(),
		});
		expect(result.ok).toBe(true);
	});

	it("binds ath to the access token", async () => {
		const accessToken = "eyJ.token.sig";
		const proof = await mintDpopProof(signer, publicJwk, {
			htm: "POST",
			htu: URL_,
			nowMs: NOW,
			accessToken,
		});
		expect(decodeCompactJws(proof)?.payload.ath).toBe(
			createHash("sha256").update(accessToken).digest("base64url"),
		);
		const ok = await verifyDpopProof({
			proof,
			htm: "POST",
			htu: URL_,
			nowMs: NOW,
			accessToken,
			replay: replay(),
		});
		expect(ok.ok).toBe(true);
		const wrong = await verifyDpopProof({
			proof,
			htm: "POST",
			htu: URL_,
			nowMs: NOW,
			accessToken: "another",
			replay: replay(),
		});
		expect(wrong.ok).toBe(false);
	});

	it("refuses a tampered proof, a wrong typ and a proof signed by another key", async () => {
		const proof = await mintDpopProof(signer, publicJwk, {
			htm: "POST",
			htu: URL_,
			nowMs: NOW,
		});
		const [h, p, s] = proof.split(".");
		const payload = JSON.parse(
			Buffer.from(p ?? "", "base64url").toString("utf8"),
		);
		const tampered = `${h}.${Buffer.from(JSON.stringify({ ...payload, htm: "GET" })).toString("base64url")}.${s}`;
		const expectInvalid = async (candidate: string, htm = "POST") => {
			const result = await verifyDpopProof({
				proof: candidate,
				htm,
				htu: URL_,
				nowMs: NOW,
				replay: replay(),
			});
			expect(result.ok ? undefined : result.error.code).toBe("proof-invalid");
		};
		await expectInvalid(tampered, "GET");
		const header = JSON.parse(
			Buffer.from(h ?? "", "base64url").toString("utf8"),
		);
		await expectInvalid(
			`${Buffer.from(JSON.stringify({ ...header, typ: "jwt" })).toString("base64url")}.${p}.${s}`,
		);
		const other = generateSigningKey(algorithm);
		await expectInvalid(
			`${Buffer.from(JSON.stringify({ ...header, jwk: other.publicJwk })).toString("base64url")}.${p}.${s}`,
		);
		await expectInvalid("not-a-jws");
		await expectInvalid(`${h}.${p}`);
	});

	it("refuses a signer whose algorithm does not fit the JWK", async () => {
		const other = generateSigningKey(
			algorithm === KeyAlgorithm.ES256
				? KeyAlgorithm.EDDSA
				: KeyAlgorithm.ES256,
		);
		await expect(
			mintDpopProof(signer, other.publicJwk, {
				htm: "GET",
				htu: URL_,
				nowMs: NOW,
			}),
		).rejects.toThrow();
	});
});

describe("verifyDpopProof replay", () => {
	it("claims each jti once per key, until the proof could no longer pass", async () => {
		const calls: Array<readonly [string, string, number]> = [];
		const store = createMemoryReplayStore(() => NOW);
		const spy: ReplayStore = {
			firstUse(scope, id, expiresAtMs) {
				calls.push([scope, id, expiresAtMs]);
				return store.firstUse(scope, id, expiresAtMs);
			},
		};
		const { signer, publicJwk } = generateDpopKey();
		const proof = await mintDpopProof(signer, publicJwk, {
			htm: "POST",
			htu: URL_,
			nowMs: NOW,
		});
		const input = { proof, htm: "POST", htu: URL_, nowMs: NOW, replay: spy };
		expect((await verifyDpopProof(input)).ok).toBe(true);
		const second = await verifyDpopProof(input);
		expect(second.ok ? undefined : second.error.code).toBe("proof-replayed");
		expect(calls[0]?.[0]).toBe(`dpop:${jwkThumbprint(publicJwk)}`);
		expect(calls[0]?.[2]).toBe(NOW + 60_000);
	});

	it("reports an unavailable replay store as unavailable, not as a pass", async () => {
		const { signer, publicJwk } = generateDpopKey();
		const proof = await mintDpopProof(signer, publicJwk, {
			htm: "POST",
			htu: URL_,
			nowMs: NOW,
		});
		const result = await verifyDpopProof({
			proof,
			htm: "POST",
			htu: URL_,
			nowMs: NOW,
			replay: {
				firstUse: async () => {
					throw new Error("store down");
				},
			},
		});
		expect(result.ok ? undefined : result.error.code).toBe("unavailable");
	});

	it("forgets a jti once it has expired", async () => {
		let now = NOW;
		const store = createMemoryReplayStore(() => now);
		expect(await store.firstUse("s", "a", NOW + 1_000)).toBe(true);
		expect(await store.firstUse("s", "a", NOW + 1_000)).toBe(false);
		expect(await store.firstUse("t", "a", NOW + 1_000)).toBe(true);
		now = NOW + 1_000;
		expect(await store.firstUse("s", "a", NOW + 2_000)).toBe(true);
	});
});
