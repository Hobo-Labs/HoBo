/**
 * Key bundles as the authority checks them (§6.4, §7.4; L02 private): signed
 * by the identity key under `hobo-fleet/key-bundle/v1`, naming the member,
 * exactly one SIGN (Ed25519) and one SEAL key, at most one TRANSPORT key, a
 * strictly increasing sequence, and a lifetime fleet policy allows.
 */
import { fromBinary } from "@bufbuild/protobuf";
import {
	type FleetPolicy,
	KeyAlgorithm,
	type KeyBundle,
	KeyBundleSchema,
	KeyPurpose,
	type PublicKeyRef,
	type SignedEnvelope,
} from "../_generated/fleet_pb.js";
import { KEY_BUNDLE_CONTEXT } from "../contexts.js";
import { jwkThumbprint, verifyEnvelope } from "../keys/index.js";
import type { Outcome, PublicJwk } from "../ports.js";
import { refuse } from "./context.js";
import { checkBundleLifetime } from "./policy.js";

export function verifyBundle(
	envelope: SignedEnvelope | undefined,
	identity: PublicJwk,
	memberId: string,
	context: Readonly<{ policy: FleetPolicy; nowMs: number; after: number }>,
): Outcome<KeyBundle> {
	if (envelope === undefined)
		return refuse("invalid-request", "the request carries no key bundle");
	if (!verifyEnvelope(envelope, KEY_BUNDLE_CONTEXT, identity))
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
	if (bundle.memberId !== memberId)
		return refuse("invalid-request", "the key bundle names another member");
	const of = (purpose: KeyPurpose) =>
		bundle.keys.filter((key) => key.purpose === purpose);
	const sign = of(KeyPurpose.SIGN);
	if (
		sign.length !== 1 ||
		sign[0]?.algorithm !== KeyAlgorithm.EDDSA ||
		of(KeyPurpose.SEAL).length !== 1 ||
		of(KeyPurpose.TRANSPORT).length > 1 ||
		bundle.keys.length !== 1 + 1 + of(KeyPurpose.TRANSPORT).length
	)
		return refuse(
			"invalid-request",
			"a key bundle has exactly one SIGN (Ed25519) and one SEAL key and at most one TRANSPORT key",
		);
	if (bundle.sequence <= context.after)
		return refuse("invalid-request", "the key bundle's sequence must increase");
	const lifetime = checkBundleLifetime(
		context.policy,
		bundle.issuedAt,
		bundle.notAfter,
		context.nowMs,
	);
	if (!lifetime.ok) return lifetime;
	return { ok: true, value: bundle };
}

export function decodeBundle(
	envelope: SignedEnvelope | undefined,
): KeyBundle | undefined {
	if (envelope === undefined) return undefined;
	try {
		return fromBinary(KeyBundleSchema, envelope.payload);
	} catch {
		return undefined;
	}
}

export function signRefOf(
	bundle: KeyBundle | undefined,
): PublicKeyRef | undefined {
	return bundle?.keys.find((key) => key.purpose === KeyPurpose.SIGN);
}

/** The RFC 7638 thumbprint of the bundle's SIGN key, which DPoP proofs after enrollment carry as `jkt`. */
export function signThumbprint(bundle: KeyBundle | undefined): string {
	const ref = signRefOf(bundle);
	if (ref === undefined) return "";
	return jwkThumbprint({ kty: "OKP", crv: "Ed25519", x: ref.value });
}
