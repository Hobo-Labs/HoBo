// O7: nothing unsigned or altered is trusted. Any single-bit change, wrong
// context or unlisted key is rejected, 10,000 cases per envelope kind.
import { create, equals, fromBinary, toBinary } from "@bufbuild/protobuf";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	KeyAlgorithm,
	KeyPurpose,
	type SignedEnvelope,
	SignedEnvelopeSchema,
	type WitnessedEnvelope,
	WitnessedEnvelopeSchema,
} from "../../src/_generated/fleet_pb.js";
import {
	AUDIT_CHECKPOINT_CONTEXT,
	CLAIM_CONTEXT,
	FLEET_CONTEXTS,
	MEMBER_RECORD_CONTEXT,
} from "../../src/contexts.js";
import { signingInput } from "../../src/keys/envelope.js";
import {
	parsePublicJwk,
	signEnvelope,
	verifyEnvelope,
	verifyWitnessed,
} from "../../src/keys/index.js";
import { testKey, trustKeys, trustRecord } from "./fixtures.js";

const RUNS = 10_000;

function must<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("missing test fixture");
	return value;
}
const TIMEOUT_MS = 180_000;

function flipBit(bytes: Uint8Array, bit: number): Uint8Array {
	const out = new Uint8Array(bytes);
	const index = Math.floor(bit / 8) % out.length;
	out[index] = (out[index] ?? 0) ^ (1 << (bit % 8));
	return out;
}

const SIGNED_FIELDS = [
	"context",
	"keyId",
	"algorithm",
	"payload",
	"signature",
] as const;

/** The envelope with one bit of one field flipped; undefined when the field is empty. */
function flipField(
	envelope: SignedEnvelope,
	field: (typeof SIGNED_FIELDS)[number],
	bit: number,
): SignedEnvelope | undefined {
	switch (field) {
		case "context":
		case "keyId": {
			const bytes = Buffer.from(envelope[field], "latin1");
			if (bytes.length === 0) return undefined;
			return create(SignedEnvelopeSchema, {
				...envelope,
				[field]: Buffer.from(flipBit(bytes, bit)).toString("latin1"),
			});
		}
		case "algorithm":
			return create(SignedEnvelopeSchema, {
				...envelope,
				algorithm: envelope.algorithm ^ (1 << (bit % 2)),
			});
		case "payload":
		case "signature":
			if (envelope[field].length === 0) return undefined;
			return create(SignedEnvelopeSchema, {
				...envelope,
				[field]: flipBit(envelope[field], bit),
			});
	}
}

function decodeSigned(bytes: Uint8Array): SignedEnvelope | undefined {
	try {
		return fromBinary(SignedEnvelopeSchema, bytes);
	} catch {
		return undefined;
	}
}

function decodeWitnessed(bytes: Uint8Array): WitnessedEnvelope | undefined {
	try {
		return fromBinary(WitnessedEnvelopeSchema, bytes);
	} catch {
		return undefined;
	}
}

const payloads = fc.uint8Array({ minLength: 0, maxLength: 200 });
const otherContexts = FLEET_CONTEXTS.filter(
	(context) => context !== CLAIM_CONTEXT,
);

describe.each([
	["ES256", KeyAlgorithm.ES256],
	["EdDSA", KeyAlgorithm.EDDSA],
] as const)("SignedEnvelope (%s)", (_name, algorithm) => {
	const key = testKey(
		"dev_0123456789abcdef0123456789abcdef#sign",
		KeyPurpose.SIGN,
		algorithm,
	);
	const impostor = testKey(
		"dev_0123456789abcdef0123456789abcdef#sign",
		KeyPurpose.SIGN,
		algorithm,
	);

	it(
		"verifies as signed, and rejects any single-bit change of the envelope",
		async () => {
			await fc.assert(
				fc.asyncProperty(
					payloads,
					fc.constantFrom(...SIGNED_FIELDS),
					fc.nat(),
					async (payload, field, bit) => {
						const envelope = await signEnvelope(
							key.signer,
							CLAIM_CONTEXT,
							payload,
						);
						expect(verifyEnvelope(envelope, CLAIM_CONTEXT, key.ref)).toBe(true);
						// Every bit of every field the envelope carries.
						const changed = flipField(envelope, field, bit);
						if (changed !== undefined)
							expect(verifyEnvelope(changed, CLAIM_CONTEXT, key.ref)).toBe(
								false,
							);
						// Every bit of the wire encoding that decodes to a different envelope.
						const altered = decodeSigned(
							flipBit(toBinary(SignedEnvelopeSchema, envelope), bit),
						);
						if (
							altered !== undefined &&
							!equals(SignedEnvelopeSchema, altered, envelope)
						)
							expect(verifyEnvelope(altered, CLAIM_CONTEXT, key.ref)).toBe(
								false,
							);
					},
				),
				{ numRuns: RUNS },
			);
		},
		TIMEOUT_MS,
	);

	it(
		"rejects a wrong context, whether expected or relabelled",
		async () => {
			await fc.assert(
				fc.asyncProperty(
					payloads,
					fc.constantFrom(...otherContexts),
					async (payload, other) => {
						const envelope = await signEnvelope(
							key.signer,
							CLAIM_CONTEXT,
							payload,
						);
						expect(verifyEnvelope(envelope, other, key.ref)).toBe(false);
						const relabelled = create(SignedEnvelopeSchema, {
							...envelope,
							context: other,
						});
						expect(verifyEnvelope(relabelled, other, key.ref)).toBe(false);
						expect(verifyEnvelope(relabelled, CLAIM_CONTEXT, key.ref)).toBe(
							false,
						);
					},
				),
				{ numRuns: RUNS },
			);
		},
		TIMEOUT_MS,
	);

	it(
		"rejects a key that is not the signer's, under the same key id",
		async () => {
			await fc.assert(
				fc.asyncProperty(payloads, async (payload) => {
					const envelope = await signEnvelope(
						key.signer,
						CLAIM_CONTEXT,
						payload,
					);
					expect(verifyEnvelope(envelope, CLAIM_CONTEXT, impostor.ref)).toBe(
						false,
					);
					const forged = await signEnvelope(
						impostor.signer,
						CLAIM_CONTEXT,
						payload,
					);
					expect(verifyEnvelope(forged, CLAIM_CONTEXT, key.ref)).toBe(false);
				}),
				{ numRuns: RUNS },
			);
		},
		TIMEOUT_MS,
	);

	it("rejects an envelope whose key id or algorithm does not name the key", async () => {
		const envelope = await signEnvelope(
			key.signer,
			CLAIM_CONTEXT,
			new Uint8Array([1]),
		);
		const otherId = create(SignedEnvelopeSchema, {
			...envelope,
			keyId: "dev_ffffffffffffffffffffffffffffffff#sign",
		});
		expect(verifyEnvelope(otherId, CLAIM_CONTEXT, key.ref)).toBe(false);
		const otherAlg = create(SignedEnvelopeSchema, {
			...envelope,
			algorithm:
				algorithm === KeyAlgorithm.ES256
					? KeyAlgorithm.EDDSA
					: KeyAlgorithm.ES256,
		});
		expect(verifyEnvelope(otherAlg, CLAIM_CONTEXT, key.ref)).toBe(false);
	});

	it("signs utf8(context) || 0x00 || payload, nothing re-serialised", async () => {
		const payload = new Uint8Array([0, 1, 2, 255]);
		const envelope = await signEnvelope(
			key.signer,
			MEMBER_RECORD_CONTEXT,
			payload,
		);
		expect(envelope.payload).toEqual(payload);
		expect(envelope.keyId).toBe(key.signer.keyId);
		expect(envelope.algorithm).toBe(algorithm);
		const input = signingInput(MEMBER_RECORD_CONTEXT, payload);
		expect(Buffer.from(input).toString("latin1")).toBe(
			`${MEMBER_RECORD_CONTEXT}\u0000\u0000\u0001\u0002ÿ`,
		);
	});
});

describe("SignedEnvelope keys", () => {
	it("never verifies with a SEAL or TRANSPORT key ref", async () => {
		const key = testKey(
			"dev_0123456789abcdef0123456789abcdef#sign",
			KeyPurpose.SIGN,
			KeyAlgorithm.EDDSA,
		);
		const envelope = await signEnvelope(
			key.signer,
			CLAIM_CONTEXT,
			new Uint8Array([7]),
		);
		for (const purpose of [KeyPurpose.SEAL, KeyPurpose.TRANSPORT])
			expect(
				verifyEnvelope(envelope, CLAIM_CONTEXT, { ...key.ref, purpose }),
			).toBe(false);
	});

	it("verifies against an identity JWK ref and a bare JWK", async () => {
		const key = testKey(
			"dev_0123456789abcdef0123456789abcdef#identity",
			KeyPurpose.IDENTITY,
			KeyAlgorithm.ES256,
		);
		const envelope = await signEnvelope(
			key.signer,
			CLAIM_CONTEXT,
			new Uint8Array([7]),
		);
		expect(verifyEnvelope(envelope, CLAIM_CONTEXT, key.ref)).toBe(true);
		const jwk = parsePublicJwk(key.ref.value);
		if (!jwk.ok) throw new Error(jwk.error.message);
		expect(verifyEnvelope(envelope, CLAIM_CONTEXT, jwk.value)).toBe(true);
		expect(
			verifyEnvelope(envelope, CLAIM_CONTEXT, {
				kty: "OKP",
				crv: "Ed25519",
				x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
			}),
		).toBe(false);
	});

	it("accepts a compressed P-256 point in a raw key ref", async () => {
		const key = testKey(
			"authority#1",
			KeyPurpose.AUTHORITY,
			KeyAlgorithm.ES256,
		);
		const raw = Buffer.from(key.ref.value, "base64url");
		const y = raw[64] ?? 0;
		const compressed = Buffer.concat([
			Buffer.from([y % 2 === 0 ? 2 : 3]),
			raw.subarray(1, 33),
		]).toString("base64url");
		const envelope = await signEnvelope(
			key.signer,
			CLAIM_CONTEXT,
			new Uint8Array([7]),
		);
		expect(
			verifyEnvelope(envelope, CLAIM_CONTEXT, {
				...key.ref,
				value: compressed,
			}),
		).toBe(true);
	});
});

describe("WitnessedEnvelope", () => {
	const keys = trustKeys(2);
	const trust = trustRecord(1, keys);
	const unlisted = trustKeys(2, 7);
	const authority = must(keys.authority[0]).signer;
	const witness = must(keys.witness[1]).signer;

	async function witnessedOf(payload: Uint8Array): Promise<WitnessedEnvelope> {
		return create(WitnessedEnvelopeSchema, {
			authority: await signEnvelope(
				authority,
				AUDIT_CHECKPOINT_CONTEXT,
				payload,
			),
			witness: await signEnvelope(witness, AUDIT_CHECKPOINT_CONTEXT, payload),
		});
	}

	it(
		"verifies as signed, and rejects any single-bit change of the envelope",
		async () => {
			await fc.assert(
				fc.asyncProperty(
					payloads,
					fc.constantFrom("authority", "witness"),
					fc.constantFrom(...SIGNED_FIELDS),
					fc.nat(),
					async (payload, part, field, bit) => {
						const envelope = await witnessedOf(payload);
						expect(
							verifyWitnessed(envelope, AUDIT_CHECKPOINT_CONTEXT, trust),
						).toBe(true);
						const inner = envelope[part];
						const changedInner =
							inner === undefined ? undefined : flipField(inner, field, bit);
						if (changedInner !== undefined)
							expect(
								verifyWitnessed(
									create(WitnessedEnvelopeSchema, {
										...envelope,
										[part]: changedInner,
									}),
									AUDIT_CHECKPOINT_CONTEXT,
									trust,
								),
							).toBe(false);
						const altered = decodeWitnessed(
							flipBit(toBinary(WitnessedEnvelopeSchema, envelope), bit),
						);
						if (
							altered !== undefined &&
							!equals(WitnessedEnvelopeSchema, altered, envelope)
						)
							expect(
								verifyWitnessed(altered, AUDIT_CHECKPOINT_CONTEXT, trust),
							).toBe(false);
					},
				),
				{ numRuns: RUNS },
			);
		},
		TIMEOUT_MS,
	);

	it(
		"rejects a wrong context and keys the trust record does not list",
		async () => {
			const other = unlisted.authority[0]?.signer;
			const otherWitness = unlisted.witness[0]?.signer;
			if (other === undefined || otherWitness === undefined)
				throw new Error("keys");
			await fc.assert(
				fc.asyncProperty(
					payloads,
					fc.constantFrom(
						...FLEET_CONTEXTS.filter((c) => c !== AUDIT_CHECKPOINT_CONTEXT),
					),
					fc.constantFrom("authority", "witness", "both"),
					async (payload, context, which) => {
						const envelope = await witnessedOf(payload);
						expect(verifyWitnessed(envelope, context, trust)).toBe(false);
						const forged = create(WitnessedEnvelopeSchema, {
							authority:
								which === "witness"
									? envelope.authority
									: await signEnvelope(
											other,
											AUDIT_CHECKPOINT_CONTEXT,
											payload,
										),
							witness:
								which === "authority"
									? envelope.witness
									: await signEnvelope(
											otherWitness,
											AUDIT_CHECKPOINT_CONTEXT,
											payload,
										),
						});
						expect(
							verifyWitnessed(forged, AUDIT_CHECKPOINT_CONTEXT, trust),
						).toBe(false);
					},
				),
				{ numRuns: RUNS },
			);
		},
		TIMEOUT_MS,
	);

	it("rejects one signature alone, swapped roles, and differing payloads", async () => {
		const envelope = await witnessedOf(new Uint8Array([1, 2, 3]));
		const only = (part: "authority" | "witness") =>
			create(WitnessedEnvelopeSchema, { [part]: envelope[part] });
		expect(
			verifyWitnessed(only("authority"), AUDIT_CHECKPOINT_CONTEXT, trust),
		).toBe(false);
		expect(
			verifyWitnessed(only("witness"), AUDIT_CHECKPOINT_CONTEXT, trust),
		).toBe(false);
		const swapped = create(WitnessedEnvelopeSchema, {
			authority: envelope.witness,
			witness: envelope.authority,
		});
		expect(verifyWitnessed(swapped, AUDIT_CHECKPOINT_CONTEXT, trust)).toBe(
			false,
		);
		const mixed = create(WitnessedEnvelopeSchema, {
			authority: envelope.authority,
			witness: await signEnvelope(
				witness,
				AUDIT_CHECKPOINT_CONTEXT,
				new Uint8Array([9]),
			),
		});
		expect(verifyWitnessed(mixed, AUDIT_CHECKPOINT_CONTEXT, trust)).toBe(false);
	});
});
