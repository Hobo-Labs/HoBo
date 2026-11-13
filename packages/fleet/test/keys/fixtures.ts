// Test keys for the envelope and trust tests: an in-memory Signer and the
// PublicKeyRef a trust record or registry would list for it.
import { create, toBinary } from "@bufbuild/protobuf";
import {
	KeyAlgorithm,
	KeyPurpose,
	type PublicKeyRef,
	PublicKeyRefSchema,
	type TrustRecord,
	TrustRecordSchema,
	type WitnessedEnvelope,
	WitnessedEnvelopeSchema,
} from "../../src/_generated/fleet_pb.js";
import { TRUST_RECORD_CONTEXT } from "../../src/contexts.js";
import { parseKeyId } from "../../src/ids.js";
import { rawValueOfJwk } from "../../src/keys/envelope.js";
import { signEnvelope } from "../../src/keys/index.js";
import { generateSigningKey, memorySigner } from "../../src/keys/signers.js";
import type { Signer } from "../../src/ports.js";

export type TestKey = Readonly<{ signer: Signer; ref: PublicKeyRef }>;

export function testKey(
	keyId: string,
	purpose: KeyPurpose,
	algorithm: KeyAlgorithm.ES256 | KeyAlgorithm.EDDSA,
): TestKey {
	const { privateKey, publicJwk } = generateSigningKey(algorithm);
	const id = parseKeyId(keyId);
	return {
		signer: memorySigner(id, privateKey),
		ref: create(PublicKeyRefSchema, {
			purpose,
			keyId: id,
			algorithm,
			value:
				purpose === KeyPurpose.IDENTITY
					? JSON.stringify(publicJwk)
					: rawValueOfJwk(publicJwk),
		}),
	};
}

export type TrustKeys = Readonly<{
	authority: readonly TestKey[];
	witness: readonly TestKey[];
}>;

export function trustKeys(n: number, first = 1): TrustKeys {
	const authority: TestKey[] = [];
	const witness: TestKey[] = [];
	for (let i = first; i < first + n; i += 1) {
		authority.push(
			testKey(
				`authority#${i}`,
				KeyPurpose.AUTHORITY,
				i % 2 === 0 ? KeyAlgorithm.ES256 : KeyAlgorithm.EDDSA,
			),
		);
		witness.push(
			testKey(
				`witness#${i}`,
				KeyPurpose.WITNESS,
				i % 2 === 0 ? KeyAlgorithm.EDDSA : KeyAlgorithm.ES256,
			),
		);
	}
	return { authority, witness };
}

export function trustRecord(
	sequence: number,
	keys: TrustKeys,
	tenant = "acme",
): TrustRecord {
	return create(TrustRecordSchema, {
		tenant,
		sequence,
		authorityKeys: keys.authority.map((key) => key.ref),
		witnessKeys: keys.witness.map((key) => key.ref),
		authorityIncarnation: 1,
		issuer: "https://authority.fleet.test",
		jwksUri: "https://authority.fleet.test/v1/fleet/jwks",
		issuedAt: "2026-11-12T10:00:00.000Z",
	});
}

/** Signs `record` with the given authority and witness signers. */
export async function witnessed(
	record: TrustRecord,
	authority: Signer,
	witness: Signer,
): Promise<WitnessedEnvelope> {
	const payload = toBinary(TrustRecordSchema, record);
	return create(WitnessedEnvelopeSchema, {
		authority: await signEnvelope(authority, TRUST_RECORD_CONTEXT, payload),
		witness: await signEnvelope(witness, TRUST_RECORD_CONTEXT, payload),
	});
}
