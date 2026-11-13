// O19 (ceremony half): the ceremony's two shares together reconstruct the
// operator key, either alone does not, and nothing else it writes holds the key.
import { createPublicKey, randomBytes, verify } from "node:crypto";
import type { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";
import { operatorJwtName } from "../../src/ops/ceremony.js";
import { runCeremony } from "../../src/ops/index.js";
import { decodeNkeySeed, unbase32 } from "../../src/ops/nkeys.js";
import { combineShares } from "../../src/ops/shares.js";
import { readSlot } from "../../src/ops/slots.js";
import { opsFixture } from "./support.js";

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

function rawOfPublicNkey(text: string): Buffer {
	const full = unbase32(text);
	if (full === undefined) throw new Error("not base32");
	return Buffer.from(full.subarray(1, 33));
}

function verifyJwt(jwt: string, publicNkey: string): boolean {
	const [header, payload, signature] = jwt.split(".");
	const key = createPublicKey({
		key: Buffer.concat([SPKI_ED25519, rawOfPublicNkey(publicNkey)]),
		format: "der",
		type: "spki",
	});
	return verify(
		null,
		Buffer.from(`${header}.${payload}`),
		key,
		Buffer.from(signature ?? "", "base64url"),
	);
}

/** Every value of every version the store holds. */
async function everything(
	secrets: ReturnType<typeof createMemorySecretsPort>,
): Promise<string[]> {
	const out: string[] = [];
	for (const name of secrets.names())
		for (const version of await secrets.listVersions(name)) {
			const read = await secrets.accessVersion(name, version);
			if (read.status === "ok") out.push(read.material ?? "");
		}
	return out;
}

describe("runCeremony", () => {
	it("returns two shares that together, in either order, reconstruct the operator key", async () => {
		const fixture = await opsFixture();
		const result = await runCeremony(fixture.context);
		if (!result.ok) throw new Error(result.error.message);
		const { operatorPublicKey, shares } = result.value;
		expect(operatorPublicKey).toMatch(/^O[A-Z2-7]{55}$/u);

		for (const [a, b] of [
			[shares[0], shares[1]],
			[shares[1], shares[0]],
		] as const) {
			const combined = combineShares(a, b);
			if (!combined.ok) throw new Error(combined.error.message);
			expect(combined.value.operatorPublicKey).toBe(operatorPublicKey);
			expect(decodeNkeySeed(combined.value.operatorSeed)?.role).toBe(
				"operator",
			);
		}
	});

	it("either share alone does not reconstruct the key", async () => {
		const fixture = await opsFixture();
		const result = await runCeremony(fixture.context);
		if (!result.ok) throw new Error(result.error.message);
		const [first, second] = result.value.shares;

		expect(combineShares(first, first).ok).toBe(false);
		expect(combineShares(second, second).ok).toBe(false);
		// A guessed partner share yields some other key, which the share's own public key exposes.
		for (const share of [first, second]) {
			const parts = share.split(":");
			const guess = [
				parts[0],
				parts[1] === "1" ? "2" : "1",
				parts[2],
				Buffer.from(randomBytes(32)).toString("base64url"),
			].join(":");
			expect(combineShares(share, guess).ok).toBe(false);
		}
		// Neither share carries the key's bytes.
		const combined = combineShares(first, second);
		if (!combined.ok) throw new Error(combined.error.message);
		const seed = decodeNkeySeed(combined.value.operatorSeed)?.seed;
		if (seed === undefined) throw new Error("no seed");
		for (const share of [first, second])
			expect(share).not.toContain(Buffer.from(seed).toString("base64url"));
	});

	it("writes nothing that holds the operator key, and signs the operator JWT with it", async () => {
		const fixture = await opsFixture();
		const result = await runCeremony(fixture.context);
		if (!result.ok) throw new Error(result.error.message);
		const combined = combineShares(...result.value.shares);
		if (!combined.ok) throw new Error(combined.error.message);
		const seed = decodeNkeySeed(combined.value.operatorSeed)?.seed;
		if (seed === undefined) throw new Error("no seed");
		const forms = [
			combined.value.operatorSeed,
			Buffer.from(seed).toString("base64url"),
			Buffer.from(seed).toString("base64"),
			Buffer.from(seed).toString("hex"),
		];
		const written = await everything(fixture.secrets);
		expect(written.length).toBeGreaterThan(0);
		for (const value of written)
			for (const form of forms) expect(value).not.toContain(form);
		for (const line of fixture.logged)
			for (const form of forms) expect(line).not.toContain(form);

		// The key's one use: the operator JWT naming the operator signing key.
		const jwtRead = await fixture.secrets.access(
			operatorJwtName(fixture.prefix),
		);
		const jwt = jwtRead.status === "ok" ? (jwtRead.material ?? "") : "";
		expect(verifyJwt(jwt, result.value.operatorPublicKey)).toBe(true);
		const claims = JSON.parse(
			Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString(),
		);
		const signing = await readSlot(
			fixture.secrets,
			fixture.prefix,
			"operator-signing",
		);
		if (!signing.ok || signing.value === undefined) throw new Error("no slot");
		expect(claims.nats.signing_keys).toEqual([
			signing.value.keys[0]?.publicKey,
		]);
		expect(claims.iss).toBe(result.value.operatorPublicKey);
	});

	it("stores each key in its own secret, and refuses to run twice", async () => {
		const fixture = await opsFixture();
		const first = await runCeremony(fixture.context);
		expect(first.ok).toBe(true);
		const names = fixture.secrets.names();
		for (const which of [
			"operator-signing",
			"record-signing",
			"witness",
			"token-signing",
		])
			expect(names).toContain(`${fixture.prefix}/${which}`);

		const second = await runCeremony(fixture.context);
		expect(second.ok ? "" : second.error.code).toBe("conflict");
	});
});
