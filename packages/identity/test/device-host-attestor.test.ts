import {
	HOST_ATTESTATION_CONTEXT,
	KeyAlgorithm,
	type Signer,
} from "@hobo/fleet";
import { createMemoryKeyStore } from "@hobo/fleet/keys";
import { describe, expect, it } from "vitest";
import {
	type AttestationDocument,
	createDeviceHostAttestor,
	createFixtureHostAttestor,
	type LaunchMeasurement,
	verifyWorkloadAttestation,
} from "../src/index.js";

const NOW = "2026-11-13T10:00:00.000Z";
const IMAGE = `sha256:${"a".repeat(64)}`;

function measurement(hostId: string): LaunchMeasurement {
	return {
		runId: "run-1",
		tenant: "tenant-a",
		parentPrincipal: { kind: "service", id: "fleet-authority" },
		codeVersion: { digest: `sha256:${"b".repeat(64)}`, version: "1.0.0" },
		componentImageDigest: IMAGE,
		hostId,
		issuedAt: "2026-11-13T09:59:00.000Z",
		expiresAt: "2026-11-13T10:10:00.000Z",
		nonce: "nonce-1",
		isolationTier: "gvisor",
	};
}

async function device() {
	const keys = await createMemoryKeyStore().open();
	const hostKey = {
		hostId: keys.memberId,
		keyId: keys.sign.keyId,
		verificationKey: keys.signPublicKey,
	};
	return { keys, hostKey, attestor: createDeviceHostAttestor(keys.sign) };
}

function verifyWith(
	document: AttestationDocument,
	hostPublicKeys: readonly {
		hostId: string;
		keyId: string;
		verificationKey: string;
	}[],
) {
	return verifyWorkloadAttestation(document, {
		knownImageDigests: [IMAGE],
		hostPublicKeys,
		now: NOW,
	});
}

describe("createDeviceHostAttestor", () => {
	it("signs the launch measurement as a fleet envelope from the device's SIGN key, with the member id as host id", async () => {
		const { keys, hostKey, attestor } = await device();
		const document = await attestor.createDocument({
			launchMeasurement: measurement(keys.memberId),
		});

		expect(document.launchMeasurement.hostId).toBe(keys.memberId);
		expect(document.hostSignature).toMatchObject({
			hostId: keys.memberId,
			keyId: `${keys.memberId}#sign`,
			algorithm: "hobo-fleet-envelope/eddsa",
		});
		expect(verifyWith(document, [hostKey])).toMatchObject({
			state: "attested",
			reason: "host-signature-valid",
			binding: { runId: "run-1", tenant: "tenant-a" },
		});
	});

	it("fills an empty host id with the member id and refuses another host's id", async () => {
		const { keys, hostKey, attestor } = await device();
		const filled = await attestor.createDocument({
			launchMeasurement: measurement(""),
		});
		expect(filled.launchMeasurement.hostId).toBe(keys.memberId);
		expect(verifyWith(filled, [hostKey]).state).toBe("attested");

		await expect(
			attestor.createDocument({ launchMeasurement: measurement("other-host") }),
		).rejects.toThrow(/member id/);
	});

	it("signs under the host-attestation context and nothing else", async () => {
		const { keys, hostKey, attestor } = await device();
		const document = await attestor.createDocument({
			launchMeasurement: measurement(keys.memberId),
		});
		const [payload, signature] = document.hostSignature.value.split(".");
		const signed = Buffer.concat([
			Buffer.from(HOST_ATTESTATION_CONTEXT, "utf8"),
			Buffer.from([0]),
			Buffer.from(payload ?? "", "base64url"),
		]);
		expect(
			JSON.parse(Buffer.from(payload ?? "", "base64url").toString()),
		).toEqual(document.launchMeasurement);
		expect(Buffer.from(signature ?? "", "base64url").length).toBe(64);

		// The same key signing the same bytes under another context does not verify.
		const forged = await keys.sign.sign(
			Buffer.concat([
				Buffer.from("hobo-fleet/claim/v1\u0000"),
				signed.subarray(HOST_ATTESTATION_CONTEXT.length + 1),
			]),
		);
		const wrongContext: AttestationDocument = {
			...document,
			hostSignature: {
				...document.hostSignature,
				value: `${payload}.${Buffer.from(forged).toString("base64url")}`,
			},
		};
		expect(verifyWith(wrongContext, [hostKey])).toEqual({
			state: "unattested",
			reason: "host-signature-invalid",
		});
	});

	it("refuses a measurement changed after signing, another device's key and a key id that is not the host's SIGN key", async () => {
		const { keys, hostKey, attestor } = await device();
		const other = await device();
		const document = await attestor.createDocument({
			launchMeasurement: measurement(keys.memberId),
		});
		const unattested = {
			state: "unattested",
			reason: "host-signature-invalid",
		};

		const tampered: AttestationDocument = {
			...document,
			launchMeasurement: { ...document.launchMeasurement, tenant: "tenant-b" },
		};
		expect(verifyWith(tampered, [hostKey])).toEqual(unattested);

		expect(
			verifyWith(document, [
				{ ...hostKey, verificationKey: other.keys.signPublicKey },
			]),
		).toEqual(unattested);
		expect(verifyWith(document, [])).toEqual(unattested);

		const identityKeyId: AttestationDocument = {
			...document,
			hostSignature: {
				...document.hostSignature,
				keyId: `${keys.memberId}#identity`,
			},
		};
		expect(
			verifyWith(identityKeyId, [
				{ ...hostKey, keyId: `${keys.memberId}#identity` },
			]),
		).toEqual(unattested);

		const otherHost: AttestationDocument = {
			...document,
			hostSignature: { ...document.hostSignature, hostId: other.keys.memberId },
		};
		expect(
			verifyWith(otherHost, [{ ...hostKey, hostId: other.keys.memberId }]),
		).toEqual(unattested);

		const malformed: AttestationDocument = {
			...document,
			hostSignature: { ...document.hostSignature, value: "not-an-envelope" },
		};
		expect(verifyWith(malformed, [hostKey])).toEqual(unattested);

		const unknownAlgorithm: AttestationDocument = {
			...document,
			hostSignature: {
				...document.hostSignature,
				algorithm: "hobo-fleet-envelope/rs256",
			},
		};
		expect(verifyWith(unknownAlgorithm, [hostKey])).toEqual(unattested);
	});

	it("verifies an ES256 SIGN key", async () => {
		const { generateKeyPairSync, sign } = await import("node:crypto");
		const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
		const jwk = pair.publicKey.export({ format: "jwk" });
		const raw = Buffer.concat([
			Buffer.from([4]),
			Buffer.from(String(jwk.x), "base64url"),
			Buffer.from(String(jwk.y), "base64url"),
		]).toString("base64url");
		const { keys } = await device();
		const signer: Signer = {
			keyId: keys.sign.keyId,
			algorithm: KeyAlgorithm.ES256,
			async sign(bytes) {
				return new Uint8Array(
					sign("sha256", bytes, {
						key: pair.privateKey,
						dsaEncoding: "ieee-p1363",
					}),
				);
			},
		};
		const document = await createDeviceHostAttestor(signer).createDocument({
			launchMeasurement: measurement(keys.memberId),
		});
		expect(document.hostSignature.algorithm).toBe("hobo-fleet-envelope/es256");
		expect(
			verifyWith(document, [
				{ hostId: keys.memberId, keyId: keys.sign.keyId, verificationKey: raw },
			]).state,
		).toBe("attested");
	});

	it("takes only a SIGN key and publishes no key of its own", async () => {
		const { keys, attestor } = await device();
		expect(() => createDeviceHostAttestor(keys.identity)).toThrow(/SIGN key/);
		// The verification key is the SIGN key in the member's key bundle, read from the registry.
		expect(attestor.publicKeys()).toEqual([]);
	});

	it("keeps the fixture attestor for tests", async () => {
		const fixture = createFixtureHostAttestor({ hostId: "host-1" });
		const document = await fixture.createDocument({
			launchMeasurement: measurement("host-1"),
		});
		expect(verifyWith(document, fixture.publicKeys()).state).toBe("attested");
	});
});
