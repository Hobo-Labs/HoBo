import { constants, publicEncrypt, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
	accessCode,
	accessTokenKey,
	accessTokenMaterial,
	decryptEncString,
	decryptRsaEncString,
	encryptEncString,
	fingerprintPhrase,
	signInRequestKeyPair,
} from "../src/bitwarden-crypto.js";

// The SPKI public key of Bitwarden's own fingerprint test (sdk-internal,
// bitwarden-crypto/src/fingerprint.rs).
const KAT_SPKI = Buffer.from(
	"MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuyYs8W7NWf0Zv35Ueco9" +
		"3730dtRKi4Jhc6Snar+86drE+ruSfaCWMcbgsAoAj2Pm6KAzaJrTIVCqBERQ23On" +
		"cpzjfcGAeyf+v3w/gSw/EjihMJ4AG5ICY4hLFYcGdgwa+7is+TVO0i6PEWjKQa3l" +
		"2+mQo2XY7pg2ngHDMssV4gxSqq+qoBX3+FBhewCYdOV+3cebwsAzz7HwoFTxKViw" +
		"NW8crbHonhZPhZgfIAzEkzo5MvzQg5azhLKW6vuPfaOQFC5HqPykVnh8OPzO0uzU" +
		"i3+97CguAu4N2CgwVYXltZuw2fGamdVw3kjbxQPbOE1tL0j7gyTwYKkfUl2m8gMh" +
		"1QIDAQAB",
	"base64",
);

describe("Bitwarden crypto (against Bitwarden's own test vectors)", () => {
	it("derives the access token key exactly as the SDK does", () => {
		const seed = Buffer.from("X8vbvA0bduihIDe/qrzIQQ==", "base64");
		expect(accessTokenKey(seed).toString("base64")).toBe(
			"H9/oIRLtL9nGCQOVDjSMoEbJsjWXSOCb3qeyDt6ckzS3FhyboEDWyTP/CQfbIszNmAVg2ExFganG1FVFGXO/Jg==",
		);
	});

	it("computes the fingerprint phrase the approving device shows", () => {
		expect(
			fingerprintPhrase("a09726a0-9590-49d1-a5f5-afe300b6a515", KAT_SPKI),
		).toBe("turban-deftly-anime-chatroom-unselfish");
	});

	it("round-trips a type 2 encrypted value and rejects a tampered one", () => {
		const key = randomBytes(64);
		const text = encryptEncString("hobo", key);
		expect(text).toMatch(/^2\.[^|]+\|[^|]+\|[^|]+$/u);
		expect(decryptEncString(text, key).toString()).toBe("hobo");
		const [head = "", data = "", mac = ""] = text.split("|");
		const tampered = `${head}|${Buffer.from(data, "base64").reverse().toString("base64")}|${mac}`;
		expect(() => decryptEncString(tampered, key)).toThrow(/integrity/u);
	});

	it("opens a key a device encrypted to the request's public key", () => {
		const pair = signInRequestKeyPair();
		const userKey = randomBytes(64);
		const sealed = `4.${publicEncrypt(
			{
				key: pair.spki,
				format: "der",
				type: "spki",
				padding: constants.RSA_PKCS1_OAEP_PADDING,
				oaepHash: "sha1",
			},
			userKey,
		).toString("base64")}`;
		expect(decryptRsaEncString(sealed, pair.pkcs8).equals(userKey)).toBe(true);
	});

	it("makes token material that opens back to the organization key", () => {
		const orgKey = randomBytes(64);
		const material = accessTokenMaterial(orgKey);
		const derived = accessTokenKey(material.seed);
		const payload = JSON.parse(
			decryptEncString(material.encryptedPayload, derived).toString(),
		);
		expect(Buffer.from(payload.encryptionKey, "base64").equals(orgKey)).toBe(
			true,
		);
		expect(decryptEncString(material.key, orgKey).toString()).toBe(
			derived.toString("base64"),
		);
		expect(material.seed).toHaveLength(16);
	});

	it("makes 25-character access codes", () => {
		expect(accessCode()).toMatch(/^[A-Za-z0-9]{25}$/u);
	});
});
