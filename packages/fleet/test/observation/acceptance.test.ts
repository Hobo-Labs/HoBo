/**
 * `buildObservation` and `acceptObservation` (design §6.8 "In authority mode
 * a reader accepts an observation only if all of these hold"). Every rule has
 * a refusing case, each naming its reason, and the observation that satisfies
 * all of them is accepted.
 */
import { create, fromBinary, isMessage, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	MemberKind,
	MemberState,
	MembershipSchema,
	type Observation,
	ObservationSchema,
	type SignedEnvelope,
	SignedEnvelopeSchema,
} from "../../src/_generated/fleet_pb.js";
import { CLAIM_CONTEXT, OBSERVATION_CONTEXT } from "../../src/contexts.js";
import { type MemberId, parseMemberId } from "../../src/ids.js";
import { signEnvelope } from "../../src/keys/index.js";
import {
	acceptObservation,
	buildObservation,
} from "../../src/observation/index.js";
import type { DeviceKeys, Outcome, RegistryView } from "../../src/ports.js";
import {
	deviceKeys,
	deviceRecord,
	iso,
	keyBundle,
	NOW,
	observation,
	registry,
	sponsoredRecord,
} from "./fixtures.js";

const BACKEND = parseMemberId(`bkd_${"a".repeat(32)}`);

async function signed(
	keys: DeviceKeys,
	input: Observation,
): Promise<SignedEnvelope> {
	const built = await buildObservation(input, keys.sign);
	if (!isMessage(built, SignedEnvelopeSchema))
		throw new Error("a signer was given, so the observation is signed");
	return built;
}

function reason(outcome: Outcome<Observation>): string | undefined {
	return outcome.ok ? undefined : outcome.error.detail?.reason;
}

async function accept(
	view: RegistryView,
	envelope: SignedEnvelope,
	observerId: MemberId,
	memberId: MemberId = observerId,
	lastIssuedAtMs: number | undefined = undefined,
	nowMs = NOW,
): Promise<Outcome<Observation>> {
	return acceptObservation(
		{ observerId, memberId, envelope },
		view,
		lastIssuedAtMs,
		nowMs,
	);
}

describe("buildObservation", () => {
	it("returns the observation itself without a signer (local mode)", async () => {
		const input = observation(`dev_${"1".repeat(32)}`);
		expect(await buildObservation(input, undefined)).toBe(input);
	});

	it("signs the protobuf binary under the observation context", async () => {
		const keys = await deviceKeys();
		const input = observation(keys.memberId);
		const envelope = await signed(keys, input);
		expect(envelope.context).toBe(OBSERVATION_CONTEXT);
		expect(envelope.keyId).toBe(`${keys.memberId}#sign`);
		expect(fromBinary(ObservationSchema, envelope.payload)).toEqual(input);
	});
});

describe("acceptObservation", () => {
	it("accepts a device's own observation that satisfies every rule", async () => {
		const keys = await deviceKeys();
		const view = registry([await deviceRecord(keys)]);
		const input = observation(keys.memberId);
		const outcome = await accept(
			view,
			await signed(keys, input),
			keys.memberId,
			keys.memberId,
			NOW - 1,
		);
		expect(outcome).toEqual({ ok: true, value: input });
	});

	it("accepts a sponsor's observation of the backend it sponsors", async () => {
		const keys = await deviceKeys();
		const view = registry([
			await deviceRecord(keys),
			sponsoredRecord(BACKEND, keys.memberId),
		]);
		const outcome = await accept(
			view,
			await signed(keys, observation(BACKEND, { observerId: keys.memberId })),
			keys.memberId,
			BACKEND,
		);
		expect(outcome.ok).toBe(true);
	});

	it("refuses a bucket key that differs from the signed observer or member", async () => {
		const keys = await deviceKeys();
		const other = await deviceKeys();
		const view = registry([
			await deviceRecord(keys),
			await deviceRecord(other),
		]);
		const envelope = await signed(keys, observation(keys.memberId));
		expect(
			reason(await accept(view, envelope, keys.memberId, other.memberId)),
		).toBe("key-mismatch");
		// Signed as someone else's statement, filed under the signer's key.
		const claimed = await signed(
			keys,
			observation(other.memberId, { observerId: other.memberId }),
		);
		expect(reason(await accept(view, claimed, keys.memberId))).toBe(
			"key-mismatch",
		);
	});

	it("refuses an envelope under another context", async () => {
		const keys = await deviceKeys();
		const view = registry([await deviceRecord(keys)]);
		const envelope = await signEnvelope(
			keys.sign,
			CLAIM_CONTEXT,
			toBinary(ObservationSchema, observation(keys.memberId)),
		);
		const outcome = await accept(view, envelope, keys.memberId);
		expect(reason(outcome)).toBe("context");
		expect(outcome.ok ? undefined : outcome.error.code).toBe("proof-invalid");
	});

	it("refuses a signature that does not verify against the observer's SIGN key", async () => {
		const keys = await deviceKeys();
		const view = registry([await deviceRecord(keys)]);
		const envelope = await signed(keys, observation(keys.memberId));
		const altered = create(SignedEnvelopeSchema, {
			...envelope,
			payload: toBinary(
				ObservationSchema,
				observation(keys.memberId, { capacity: { freeSlots: 64 } }),
			),
		});
		expect(reason(await accept(view, altered, keys.memberId))).toBe(
			"signature",
		);
		// Another device's SIGN key under this device's key id.
		const thief = await deviceKeys();
		const forged = create(SignedEnvelopeSchema, {
			...(await signed(thief, observation(keys.memberId))),
			keyId: `${keys.memberId}#sign`,
		});
		expect(reason(await accept(view, forged, keys.memberId))).toBe("signature");
	});

	it("refuses a key id that is not the bundle's SIGN key", async () => {
		const keys = await deviceKeys();
		const view = registry([await deviceRecord(keys)]);
		const envelope = create(SignedEnvelopeSchema, {
			...(await signed(keys, observation(keys.memberId))),
			keyId: `${keys.memberId}#identity`,
		});
		expect(reason(await accept(view, envelope, keys.memberId))).toBe(
			"key-unknown",
		);
	});

	it("refuses a key bundle that has expired", async () => {
		const keys = await deviceKeys();
		const view = registry([
			await deviceRecord(keys, { keyBundle: await keyBundle(keys, NOW) }),
		]);
		const envelope = await signed(keys, observation(keys.memberId));
		expect(reason(await accept(view, envelope, keys.memberId))).toBe(
			"bundle-expired",
		);
	});

	it("refuses a key bundle not signed by the observer's identity key", async () => {
		const keys = await deviceKeys();
		const other = await deviceKeys();
		// The other device's bundle names this device but is signed by the other identity.
		const bundle = await keyBundle(other);
		const view = registry([await deviceRecord(keys, { keyBundle: bundle })]);
		const envelope = await signed(keys, observation(keys.memberId));
		expect(reason(await accept(view, envelope, keys.memberId))).toBe(
			"bundle-invalid",
		);
		const unbundled = await deviceRecord(keys);
		delete unbundled.keyBundle;
		const missing = registry([unbundled]);
		expect(reason(await accept(missing, envelope, keys.memberId))).toBe(
			"bundle-invalid",
		);
	});

	it("refuses an observer the registry does not know", async () => {
		const keys = await deviceKeys();
		const envelope = await signed(keys, observation(keys.memberId));
		const outcome = await accept(registry([]), envelope, keys.memberId);
		expect(reason(outcome)).toBe("observer-unknown");
		expect(outcome.ok ? undefined : outcome.error.code).toBe("member-unknown");
	});

	it("refuses an observer that is not ACTIVE", async () => {
		const keys = await deviceKeys();
		for (const state of [
			MemberState.PENDING,
			MemberState.SUSPENDED,
			MemberState.LOCKED,
			MemberState.REVOKED,
		]) {
			const view = registry([await deviceRecord(keys, { state })]);
			const envelope = await signed(keys, observation(keys.memberId));
			expect(reason(await accept(view, envelope, keys.memberId))).toBe(
				"observer-not-active",
			);
		}
	});

	it("refuses an observation of a sponsored member signed by a sponsor that is not a DEVICE", async () => {
		const keys = await deviceKeys();
		// The sponsor's record exists but is a backend: it has no SIGN key in a bundle.
		const sponsor = await deviceRecord(keys, { kind: MemberKind.BACKEND });
		const view = registry([sponsor, sponsoredRecord(BACKEND, keys.memberId)]);
		const envelope = await signed(
			keys,
			observation(BACKEND, { observerId: keys.memberId }),
		);
		expect(reason(await accept(view, envelope, keys.memberId, BACKEND))).toBe(
			"observer-not-device",
		);
		// A service principal sponsor: no member record at all.
		const principal = registry([sponsoredRecord(BACKEND, "service:ops")]);
		expect(
			reason(await accept(principal, envelope, keys.memberId, BACKEND)),
		).toBe("observer-unknown");
	});

	it("refuses an observer that is not the member's recorded sponsor", async () => {
		const keys = await deviceKeys();
		const sponsor = await deviceKeys();
		const view = registry([
			await deviceRecord(keys),
			await deviceRecord(sponsor),
			sponsoredRecord(BACKEND, sponsor.memberId),
		]);
		const envelope = await signed(
			keys,
			observation(BACKEND, { observerId: keys.memberId }),
		);
		expect(reason(await accept(view, envelope, keys.memberId, BACKEND))).toBe(
			"not-sponsor",
		);
		const unknown = registry([await deviceRecord(keys)]);
		expect(
			reason(await accept(unknown, envelope, keys.memberId, BACKEND)),
		).toBe("member-unknown");
	});

	it("refuses a member that is not ACTIVE in every fleet the observation names", async () => {
		const keys = await deviceKeys();
		const suspended = registry([
			await deviceRecord(keys),
			sponsoredRecord(BACKEND, keys.memberId, {
				state: MemberState.SUSPENDED,
			}),
		]);
		const envelope = await signed(
			keys,
			observation(BACKEND, { observerId: keys.memberId }),
		);
		expect(
			reason(await accept(suspended, envelope, keys.memberId, BACKEND)),
		).toBe("member-not-active");
		const view = registry([
			await deviceRecord(keys, {
				memberships: [create(MembershipSchema, { fleet: "hobo", name: "box" })],
			}),
		]);
		const elsewhere = await signed(
			keys,
			observation(keys.memberId, { fleets: ["hobo", "hobo-trunk"] }),
		);
		expect(reason(await accept(view, elsewhere, keys.memberId))).toBe(
			"not-in-fleet",
		);
	});

	it("refuses an issued_at no later than the last one accepted", async () => {
		const keys = await deviceKeys();
		const view = registry([await deviceRecord(keys)]);
		const envelope = await signed(keys, observation(keys.memberId));
		for (const last of [NOW, NOW + 1])
			expect(
				reason(
					await accept(view, envelope, keys.memberId, keys.memberId, last),
				),
			).toBe("replayed");
		expect(
			(await accept(view, envelope, keys.memberId, keys.memberId, NOW - 1)).ok,
		).toBe(true);
	});

	it("refuses a valid_until more than five minutes plus one of skew ahead", async () => {
		const keys = await deviceKeys();
		const view = registry([await deviceRecord(keys)]);
		const at = (validUntilMs: number) =>
			signed(
				keys,
				observation(keys.memberId, { validUntil: iso(validUntilMs) }),
			);
		expect(
			(await accept(view, await at(NOW + 6 * 60_000), keys.memberId)).ok,
		).toBe(true);
		expect(
			reason(await accept(view, await at(NOW + 6 * 60_000 + 1), keys.memberId)),
		).toBe("too-far-ahead");
	});

	it("refuses an observation that has already expired or whose times do not parse", async () => {
		const keys = await deviceKeys();
		const view = registry([await deviceRecord(keys)]);
		const expired = await signed(
			keys,
			observation(keys.memberId, { validUntil: iso(NOW) }),
		);
		expect(reason(await accept(view, expired, keys.memberId))).toBe("expired");
		const garbled = await signed(
			keys,
			observation(keys.memberId, { issuedAt: "yesterday" }),
		);
		expect(reason(await accept(view, garbled, keys.memberId))).toBe(
			"time-invalid",
		);
	});

	it("refuses a payload that is not an observation", async () => {
		const keys = await deviceKeys();
		const view = registry([await deviceRecord(keys)]);
		const envelope = await signEnvelope(
			keys.sign,
			OBSERVATION_CONTEXT,
			new Uint8Array([0xff, 0xff, 0xff]),
		);
		expect(reason(await accept(view, envelope, keys.memberId))).toBe("payload");
	});
});
