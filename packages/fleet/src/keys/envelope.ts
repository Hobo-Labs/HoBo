import { ECDH } from "node:crypto";
import { create, fromBinary, isMessage } from "@bufbuild/protobuf";
import {
	KeyAlgorithm,
	KeyPurpose,
	type PublicKeyRef,
	PublicKeyRefSchema,
	type SignedEnvelope,
	SignedEnvelopeSchema,
	type TrustRecord,
	TrustRecordSchema,
	type WitnessedEnvelope,
} from "../_generated/fleet_pb.js";
import { TRUST_RECORD_CONTEXT } from "../contexts.js";
import type {
	FleetContext,
	FleetFailure,
	Outcome,
	PublicJwk,
	Signer,
} from "../ports.js";
import { algorithmOf, parsePublicJwkText, verifyRaw } from "./jose.js";

const ED25519_RAW_BYTES = 32;
const P256_UNCOMPRESSED_BYTES = 65;
const P256_COMPRESSED_BYTES = 33;

export function signingInput(context: string, payload: Uint8Array): Uint8Array {
	const prefix = Buffer.from(context, "utf8");
	const out = new Uint8Array(prefix.length + 1 + payload.length);
	out.set(prefix, 0);
	out[prefix.length] = 0;
	out.set(payload, prefix.length + 1);
	return out;
}

export async function signEnvelopeWith(
	signer: Signer,
	context: FleetContext,
	payload: Uint8Array,
): Promise<SignedEnvelope> {
	const signature = await signer.sign(signingInput(context, payload));
	return create(SignedEnvelopeSchema, {
		context,
		keyId: signer.keyId,
		algorithm: signer.algorithm,
		payload: new Uint8Array(payload),
		signature: new Uint8Array(signature),
	});
}

export function signingJwkOfRef(ref: PublicKeyRef): PublicJwk | undefined {
	if (ref.purpose === KeyPurpose.IDENTITY) {
		const parsed = parsePublicJwkText(ref.value);
		return parsed.ok && algorithmOf(parsed.value) === ref.algorithm
			? parsed.value
			: undefined;
	}
	if (
		ref.purpose !== KeyPurpose.SIGN &&
		ref.purpose !== KeyPurpose.AUTHORITY &&
		ref.purpose !== KeyPurpose.WITNESS
	)
		return undefined;
	const raw = Buffer.from(ref.value, "base64url");
	if (raw.toString("base64url") !== ref.value) return undefined;
	if (ref.algorithm === KeyAlgorithm.EDDSA)
		return raw.length === ED25519_RAW_BYTES
			? { kty: "OKP", crv: "Ed25519", x: ref.value }
			: undefined;
	if (ref.algorithm === KeyAlgorithm.ES256) {
		const point = uncompressedPoint(raw);
		if (point === undefined) return undefined;
		return {
			kty: "EC",
			crv: "P-256",
			x: point.subarray(1, 33).toString("base64url"),
			y: point.subarray(33, 65).toString("base64url"),
		};
	}
	return undefined;
}

function uncompressedPoint(raw: Buffer): Buffer | undefined {
	if (raw.length === P256_UNCOMPRESSED_BYTES && raw[0] === 4) return raw;
	if (raw.length !== P256_COMPRESSED_BYTES) return undefined;
	try {
		const out = ECDH.convertKey(
			raw,
			"prime256v1",
			undefined,
			undefined,
			"uncompressed",
		);
		return Buffer.isBuffer(out) ? out : undefined;
	} catch {
		return undefined;
	}
}

export function rawValueOfJwk(jwk: PublicJwk): string {
	if (jwk.kty === "OKP") return jwk.x;
	return Buffer.concat([
		Buffer.from([4]),
		Buffer.from(jwk.x, "base64url"),
		Buffer.from(jwk.y, "base64url"),
	]).toString("base64url");
}

export function verifyEnvelopeWith(
	envelope: SignedEnvelope,
	expected: FleetContext,
	key: PublicKeyRef | PublicJwk,
): boolean {
	if (envelope.context !== expected) return false;
	let jwk: PublicJwk | undefined;
	if (isMessage(key, PublicKeyRefSchema)) {
		if (envelope.keyId !== key.keyId || envelope.algorithm !== key.algorithm)
			return false;
		jwk = signingJwkOfRef(key);
	} else {
		jwk = key;
	}
	if (jwk === undefined || envelope.algorithm !== algorithmOf(jwk))
		return false;
	return verifyRaw(
		jwk,
		signingInput(expected, envelope.payload),
		envelope.signature,
	);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return Buffer.from(a).equals(Buffer.from(b));
}

function signedBy(
	envelope: SignedEnvelope,
	expected: FleetContext,
	keys: readonly PublicKeyRef[],
	purpose: KeyPurpose,
): boolean {
	const key = keys.find(
		(candidate) =>
			candidate.keyId === envelope.keyId && candidate.purpose === purpose,
	);
	return key !== undefined && verifyEnvelopeWith(envelope, expected, key);
}

type WitnessCheck = "ok" | "missing" | "payload" | "authority" | "witness";

function checkWitnessed(
	envelope: WitnessedEnvelope,
	expected: FleetContext,
	trust: TrustRecord,
): WitnessCheck {
	const { authority, witness } = envelope;
	if (authority === undefined || witness === undefined) return "missing";
	if (!sameBytes(authority.payload, witness.payload)) return "payload";
	if (!signedBy(authority, expected, trust.authorityKeys, KeyPurpose.AUTHORITY))
		return "authority";
	if (!signedBy(witness, expected, trust.witnessKeys, KeyPurpose.WITNESS))
		return "witness";
	return "ok";
}

export function verifyWitnessedWith(
	envelope: WitnessedEnvelope,
	expected: FleetContext,
	trust: TrustRecord,
): boolean {
	return checkWitnessed(envelope, expected, trust) === "ok";
}

function refused(
	code: FleetFailure["code"],
	message: string,
	rule: string,
): Outcome<TrustRecord> {
	return { ok: false, error: { code, message, detail: { rule } } };
}

export function acceptTrustRecord(
	pinned: TrustRecord | undefined,
	next: WitnessedEnvelope,
): Outcome<TrustRecord> {
	const payload = next.authority?.payload;
	if (payload === undefined || next.witness === undefined)
		return refused(
			"invalid-request",
			"a trust record needs an authority and a witness signature",
			"witnessed",
		);
	let record: TrustRecord;
	try {
		record = fromBinary(TrustRecordSchema, payload);
	} catch {
		return refused(
			"invalid-request",
			"the trust record payload does not decode",
			"payload",
		);
	}
	if (record.authorityKeys.length === 0 || record.witnessKeys.length === 0)
		return refused(
			"invalid-request",
			"a trust record lists at least one authority and one witness key",
			"keys",
		);
	if (pinned !== undefined) {
		if (record.tenant !== pinned.tenant)
			return refused(
				"proof-invalid",
				"the trust record is for another tenant",
				"tenant",
			);
		if (record.sequence <= pinned.sequence)
			return refused(
				"proof-invalid",
				`trust record sequence ${record.sequence} is not above the pinned ${pinned.sequence}`,
				"sequence",
			);
	}
	const check = checkWitnessed(next, TRUST_RECORD_CONTEXT, pinned ?? record);
	if (check !== "ok")
		return refused(
			"proof-invalid",
			check === "witness"
				? "the witness signature does not verify against a pinned witness key"
				: check === "authority"
					? "the authority signature does not verify against a pinned authority key"
					: "the two signatures are not over the same trust record",
			check,
		);
	return { ok: true, value: record };
}
