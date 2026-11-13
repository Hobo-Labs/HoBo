// Key bundles (design §6.4): the device's operational keys, signed by its
// identity key under `hobo-fleet/key-bundle/v1`. A bundle holds exactly one
// SIGN and one SEAL key and at most one TRANSPORT key, each named
// `<MemberId>#<purpose>`, and is valid from `issued_at` to `not_after`.
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	KeyAlgorithm,
	type KeyBundle,
	KeyBundleSchema,
	KeyPurpose,
	type PublicKeyRef,
	PublicKeyRefSchema,
	type SignedEnvelope,
} from "../_generated/fleet_pb.js";
import { KEY_BUNDLE_CONTEXT } from "../contexts.js";
import type { DeviceKeys, Outcome, PublicJwk } from "../ports.js";
import { signEnvelopeWith, verifyEnvelopeWith } from "./envelope.js";
import { refuse, thumbprintOf } from "./jose.js";
import { deviceMemberId } from "./member-id.js";

const HOUR_MS = 3_600_000;
/** §6.4: `key_bundle_hours` defaults to 24 and is at most 720. */
export const MAX_KEY_BUNDLE_HOURS = 720;

export type KeyBundleInput = Readonly<{
	keys: DeviceKeys;
	signPublic: PublicKeyRef;
	sequence: number;
	nowMs: number;
	hours: number;
	transport?: PublicKeyRef;
}>;

export function sealRef(keys: DeviceKeys): PublicKeyRef {
	return create(PublicKeyRefSchema, {
		purpose: KeyPurpose.SEAL,
		keyId: `${keys.memberId}#seal`,
		algorithm: KeyAlgorithm.UNSPECIFIED,
		value: keys.sealPublicKey,
	});
}

export async function signKeyBundle(
	input: KeyBundleInput,
): Promise<SignedEnvelope> {
	if (input.hours <= 0 || input.hours > MAX_KEY_BUNDLE_HOURS)
		throw new Error(`a key bundle lives 1 to ${MAX_KEY_BUNDLE_HOURS} hours`);
	const keys = [input.signPublic, sealRef(input.keys)];
	const bundle = create(KeyBundleSchema, {
		memberId: input.keys.memberId,
		sequence: input.sequence,
		keys: input.transport === undefined ? keys : [...keys, input.transport],
		issuedAt: new Date(input.nowMs).toISOString(),
		notAfter: new Date(input.nowMs + input.hours * HOUR_MS).toISOString(),
	});
	return signEnvelopeWith(
		input.keys.identity,
		KEY_BUNDLE_CONTEXT,
		toBinary(KeyBundleSchema, bundle),
	);
}

export function verifyKeyBundle(
	envelope: SignedEnvelope,
	identityJwk: PublicJwk,
	nowMs: number,
): Outcome<KeyBundle> {
	if (!verifyEnvelopeWith(envelope, KEY_BUNDLE_CONTEXT, identityJwk))
		return refuse(
			"proof-invalid",
			"the key bundle is not signed by the identity key",
		);
	let bundle: KeyBundle;
	try {
		bundle = fromBinary(KeyBundleSchema, envelope.payload);
	} catch {
		return refuse("invalid-request", "the key bundle does not decode");
	}
	const memberId = deviceMemberId(thumbprintOf(identityJwk));
	if (bundle.memberId !== memberId || envelope.keyId !== `${memberId}#identity`)
		return refuse("proof-invalid", "the key bundle names another member");
	const count = (purpose: KeyPurpose) =>
		bundle.keys.filter((key) => key.purpose === purpose).length;
	if (
		count(KeyPurpose.SIGN) !== 1 ||
		count(KeyPurpose.SEAL) !== 1 ||
		count(KeyPurpose.TRANSPORT) > 1 ||
		bundle.keys.length !== 2 + count(KeyPurpose.TRANSPORT) ||
		bundle.keys.some(
			(key) => key.keyId !== `${memberId}#${purposeName(key.purpose)}`,
		)
	)
		return refuse(
			"invalid-request",
			"a key bundle holds one SIGN, one SEAL and at most one TRANSPORT key of its member",
		);
	const notAfter = Date.parse(bundle.notAfter);
	const issuedAt = Date.parse(bundle.issuedAt);
	if (!Number.isFinite(notAfter) || !Number.isFinite(issuedAt))
		return refuse("invalid-request", "the key bundle has no valid lifetime");
	if (nowMs >= notAfter)
		return refuse("proof-invalid", "the key bundle has expired");
	return { ok: true, value: bundle };
}

function purposeName(purpose: KeyPurpose): string {
	return purpose === KeyPurpose.SIGN
		? "sign"
		: purpose === KeyPurpose.SEAL
			? "seal"
			: purpose === KeyPurpose.TRANSPORT
				? "transport"
				: "?";
}
