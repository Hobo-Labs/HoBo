/**
 * Signing an observation, and the reader's acceptance rule in authority mode
 * (design §6.8 "In authority mode a reader accepts an observation only if all
 * of these hold"). The old mesh's three trust levels and its `requireTrusted`
 * switch are gone: an observation is verified or it is not used. A refusal
 * names its reason in `detail.reason`, which the caller counts once as
 * `hobo_fleet_observation_rejected`.
 */
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	type KeyBundle,
	KeyBundleSchema,
	KeyPurpose,
	MemberKind,
	type MemberRecord,
	MemberState,
	type Observation,
	ObservationSchema,
	type PublicKeyRef,
	type SignedEnvelope,
} from "../_generated/fleet_pb.js";
import { KEY_BUNDLE_CONTEXT, OBSERVATION_CONTEXT } from "../contexts.js";
import type { FleetErrorCode } from "../errors.js";
import { parsePublicJwk, signEnvelope, verifyEnvelope } from "../keys/index.js";
import type { KeyedEnvelope, Outcome, RegistryView, Signer } from "../ports.js";

/** An observation may ask to be believed at most this far ahead (§6.8). */
export const MAX_OBSERVATION_TTL_MS = 5 * 60_000;
/** How far an observer's clock may run ahead of the reader's. */
export const MAX_CLOCK_SKEW_MS = 60_000;

export type ObservationRejection =
	| "context"
	| "observer-unknown"
	| "observer-not-device"
	| "observer-not-active"
	| "bundle-invalid"
	| "bundle-expired"
	| "key-unknown"
	| "signature"
	| "payload"
	| "key-mismatch"
	| "member-unknown"
	| "not-sponsor"
	| "member-not-active"
	| "not-in-fleet"
	| "time-invalid"
	| "replayed"
	| "too-far-ahead"
	| "expired";

function refused(
	code: FleetErrorCode,
	reason: ObservationRejection,
): Outcome<Observation> {
	return {
		ok: false,
		error: {
			code,
			message: `observation refused: ${reason}`,
			detail: { reason },
		},
	};
}

/** Local mode returns the observation itself; authority mode signs its binary with the observer's SIGN key. */
export async function build(
	input: Observation,
	signer: Signer | undefined,
): Promise<SignedEnvelope | Observation> {
	if (signer === undefined) return input;
	return signEnvelope(
		signer,
		OBSERVATION_CONTEXT,
		toBinary(ObservationSchema, input),
	);
}

/** The observer's verified, unexpired key bundle, or why there is none. */
function bundleOf(
	observer: MemberRecord,
	nowMs: number,
): KeyBundle | "bundle-invalid" | "bundle-expired" {
	const envelope = observer.keyBundle;
	if (envelope === undefined) return "bundle-invalid";
	const identity = parsePublicJwk(observer.identityJwk);
	if (
		!identity.ok ||
		!verifyEnvelope(envelope, KEY_BUNDLE_CONTEXT, identity.value)
	)
		return "bundle-invalid";
	let bundle: KeyBundle;
	try {
		bundle = fromBinary(KeyBundleSchema, envelope.payload);
	} catch {
		return "bundle-invalid";
	}
	if (bundle.memberId !== observer.memberId) return "bundle-invalid";
	const notAfterMs = Date.parse(bundle.notAfter);
	if (!Number.isFinite(notAfterMs) || notAfterMs <= nowMs)
		return "bundle-expired";
	return bundle;
}

function decode(payload: Uint8Array): Observation | undefined {
	try {
		return fromBinary(ObservationSchema, payload);
	} catch {
		return undefined;
	}
}

export async function accept(
	keyed: KeyedEnvelope,
	registry: RegistryView,
	lastIssuedAtMs: number | undefined,
	nowMs: number,
): Promise<Outcome<Observation>> {
	const { envelope, observerId, memberId } = keyed;
	if (envelope.context !== OBSERVATION_CONTEXT)
		return refused("proof-invalid", "context");

	// The observer: an ACTIVE DEVICE with a SIGN key in an unexpired bundle.
	const observer = await registry.member(observerId);
	if (observer === undefined)
		return refused("member-unknown", "observer-unknown");
	if (observer.kind !== MemberKind.DEVICE)
		return refused("forbidden", "observer-not-device");
	if (observer.state !== MemberState.ACTIVE)
		return refused("forbidden", "observer-not-active");
	const bundle = bundleOf(observer, nowMs);
	if (bundle === "bundle-invalid" || bundle === "bundle-expired")
		return refused("proof-invalid", bundle);
	const signKey: PublicKeyRef | undefined = bundle.keys.find(
		(key) => key.purpose === KeyPurpose.SIGN && key.keyId === envelope.keyId,
	);
	if (signKey === undefined) return refused("proof-invalid", "key-unknown");
	if (!verifyEnvelope(envelope, OBSERVATION_CONTEXT, signKey))
		return refused("proof-invalid", "signature");

	// Only now are the verified bytes decoded.
	const observation = decode(envelope.payload);
	if (observation === undefined) return refused("invalid-request", "payload");
	if (
		observation.observerId !== observerId ||
		observation.memberId !== memberId
	)
		return refused("proof-invalid", "key-mismatch");

	// The member: the observer itself, or one the registry says it sponsors.
	let member: MemberRecord = observer;
	if (memberId !== observerId) {
		const sponsored = await registry.member(memberId);
		if (sponsored === undefined)
			return refused("member-unknown", "member-unknown");
		if (sponsored.sponsor !== observerId)
			return refused("forbidden", "not-sponsor");
		member = sponsored;
	}
	if (member.state !== MemberState.ACTIVE)
		return refused("forbidden", "member-not-active");
	if (
		!observation.fleets.every((fleet) =>
			member.memberships.some((entry) => entry.fleet === fleet),
		)
	)
		return refused("forbidden", "not-in-fleet");

	// Freshness: later than the last accepted, and not believed for too long.
	const issuedAtMs = Date.parse(observation.issuedAt);
	const validUntilMs = Date.parse(observation.validUntil);
	if (!Number.isFinite(issuedAtMs) || !Number.isFinite(validUntilMs))
		return refused("invalid-request", "time-invalid");
	if (lastIssuedAtMs !== undefined && issuedAtMs <= lastIssuedAtMs)
		return refused("invalid-request", "replayed");
	if (validUntilMs > nowMs + MAX_OBSERVATION_TTL_MS + MAX_CLOCK_SKEW_MS)
		return refused("invalid-request", "too-far-ahead");
	if (validUntilMs <= nowMs) return refused("invalid-request", "expired");
	return { ok: true, value: observation };
}
