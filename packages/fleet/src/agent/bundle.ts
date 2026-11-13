/**
 * The device's key bundle as the agent builds and renews it (design §6.4;
 * L07 private): its SIGN and SEAL keys, and a TRANSPORT key only when the
 * peer-to-peer adapter reports an endpoint id (an empty identity means the
 * device has none), signed by the identity key under
 * `hobo-fleet/key-bundle/v1`. A bundle is renewed once three quarters of its
 * life has passed, with the next sequence and the same lifetime.
 */
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	KeyAlgorithm,
	type KeyBundle,
	KeyBundleSchema,
	KeyPurpose,
	PublicKeyRefSchema,
	type SignedEnvelope,
} from "../_generated/fleet_pb.js";
import { KEY_BUNDLE_CONTEXT } from "../contexts.js";
import { signEnvelope } from "../keys/index.js";
import type { DeviceKeys } from "../ports.js";

export const HOUR_MS = 3_600_000;
/** §6.4: a bundle lives `key_bundle_hours`, 24 when the policy says nothing. */
export const DEFAULT_BUNDLE_HOURS = 24;
/** The shortest bundle the agent asks for, when policy refuses the default. */
export const SHORT_BUNDLE_HOURS = 1;

export async function buildBundle(
	keys: DeviceKeys,
	input: Readonly<{
		sequence: number;
		nowMs: number;
		lifetimeMs: number;
		transportIdentity: string;
	}>,
): Promise<SignedEnvelope> {
	const refs = [
		create(PublicKeyRefSchema, {
			purpose: KeyPurpose.SIGN,
			keyId: `${keys.memberId}#sign`,
			algorithm: KeyAlgorithm.EDDSA,
			value: keys.signPublicKey,
		}),
		create(PublicKeyRefSchema, {
			purpose: KeyPurpose.SEAL,
			keyId: `${keys.memberId}#seal`,
			algorithm: KeyAlgorithm.UNSPECIFIED,
			value: keys.sealPublicKey,
		}),
	];
	if (input.transportIdentity.length > 0)
		refs.push(
			create(PublicKeyRefSchema, {
				purpose: KeyPurpose.TRANSPORT,
				keyId: `${keys.memberId}#transport`,
				algorithm: KeyAlgorithm.EDDSA,
				value: input.transportIdentity,
			}),
		);
	const bundle = create(KeyBundleSchema, {
		memberId: keys.memberId,
		sequence: input.sequence,
		keys: refs,
		issuedAt: new Date(input.nowMs).toISOString(),
		notAfter: new Date(input.nowMs + input.lifetimeMs).toISOString(),
	});
	return signEnvelope(
		keys.identity,
		KEY_BUNDLE_CONTEXT,
		toBinary(KeyBundleSchema, bundle),
	);
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

/** The bundle's lifetime in milliseconds, or the default when its times do not parse. */
export function lifetimeOf(bundle: KeyBundle): number {
	const from = Date.parse(bundle.issuedAt);
	const until = Date.parse(bundle.notAfter);
	return Number.isFinite(from) && Number.isFinite(until) && until > from
		? until - from
		: DEFAULT_BUNDLE_HOURS * HOUR_MS;
}

/** Three quarters of the bundle's life have passed. */
export function renewalDue(bundle: KeyBundle, nowMs: number): boolean {
	const from = Date.parse(bundle.issuedAt);
	if (!Number.isFinite(from)) return true;
	return nowMs >= from + (lifetimeOf(bundle) * 3) / 4;
}

/** The TRANSPORT endpoint id the bundle carries, or "". */
export function transportOf(bundle: KeyBundle | undefined): string {
	return (
		bundle?.keys.find((key) => key.purpose === KeyPurpose.TRANSPORT)?.value ??
		""
	);
}
