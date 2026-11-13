// O14: the trust anchor cannot be replaced with one key. A record signed only
// by a pinned authority key, or only by a pinned witness key, or with a lower
// sequence, is rejected (design §7.4).
import { create, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	TrustRecordSchema,
	WitnessedEnvelopeSchema,
} from "../../src/_generated/fleet_pb.js";
import {
	MEMBER_RECORD_CONTEXT,
	TRUST_RECORD_CONTEXT,
} from "../../src/contexts.js";
import { acceptTrust, signEnvelope } from "../../src/keys/index.js";
import { trustKeys, trustRecord, witnessed } from "./fixtures.js";

const pinnedKeys = trustKeys(1);
const pinned = trustRecord(5, pinnedKeys);
const pinnedAuthority = pinnedKeys.authority[0]?.signer;
const pinnedWitness = pinnedKeys.witness[0]?.signer;
const rogue = trustKeys(1, 9);
const rogueAuthority = rogue.authority[0]?.signer;
const rogueWitness = rogue.witness[0]?.signer;
if (
	pinnedAuthority === undefined ||
	pinnedWitness === undefined ||
	rogueAuthority === undefined ||
	rogueWitness === undefined
)
	throw new Error("test keys");

function rule(result: ReturnType<typeof acceptTrust>): string | undefined {
	return result.ok ? undefined : result.error.detail?.rule;
}

describe("acceptTrust", () => {
	it("accepts a higher sequence signed by a pinned authority and a pinned witness key, even when it rotates both", async () => {
		const next = trustRecord(6, rogue);
		const result = acceptTrust(
			pinned,
			await witnessed(next, pinnedAuthority, pinnedWitness),
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.sequence).toBe(6);
			expect(result.value.authorityKeys[0]?.keyId).toBe("authority#9");
		}
	});

	it("rejects a record signed only by a pinned authority key (a leaked authority key)", async () => {
		const next = trustRecord(6, rogue);
		const result = acceptTrust(
			pinned,
			await witnessed(next, pinnedAuthority, rogueWitness),
		);
		expect(result.ok).toBe(false);
		expect(rule(result)).toBe("witness");
		if (!result.ok) expect(result.error.code).toBe("proof-invalid");
	});

	it("rejects a record signed only by a pinned witness key", async () => {
		const next = trustRecord(6, rogue);
		const result = acceptTrust(
			pinned,
			await witnessed(next, rogueAuthority, pinnedWitness),
		);
		expect(result.ok).toBe(false);
		expect(rule(result)).toBe("authority");
	});

	it("rejects a record whose keys are only listed in itself", async () => {
		const next = trustRecord(6, rogue);
		const result = acceptTrust(
			pinned,
			await witnessed(next, rogueAuthority, rogueWitness),
		);
		expect(result.ok).toBe(false);
	});

	it.each([
		["lower", 4],
		["equal", 5],
	])("rejects a %s sequence, correctly signed", async (_name, sequence) => {
		const result = acceptTrust(
			pinned,
			await witnessed(
				trustRecord(sequence, pinnedKeys),
				pinnedAuthority,
				pinnedWitness,
			),
		);
		expect(result.ok).toBe(false);
		expect(rule(result)).toBe("sequence");
	});

	it("rejects a record for another tenant", async () => {
		const result = acceptTrust(
			pinned,
			await witnessed(
				trustRecord(6, pinnedKeys, "other"),
				pinnedAuthority,
				pinnedWitness,
			),
		);
		expect(rule(result)).toBe("tenant");
	});

	it("rejects signatures under another context", async () => {
		const payload = toBinary(TrustRecordSchema, trustRecord(6, pinnedKeys));
		const envelope = create(WitnessedEnvelopeSchema, {
			authority: await signEnvelope(
				pinnedAuthority,
				MEMBER_RECORD_CONTEXT,
				payload,
			),
			witness: await signEnvelope(
				pinnedWitness,
				MEMBER_RECORD_CONTEXT,
				payload,
			),
		});
		expect(acceptTrust(pinned, envelope).ok).toBe(false);
	});

	it("rejects two signatures over different records", async () => {
		const a = toBinary(TrustRecordSchema, trustRecord(6, pinnedKeys));
		const b = toBinary(TrustRecordSchema, trustRecord(7, rogue));
		const envelope = create(WitnessedEnvelopeSchema, {
			authority: await signEnvelope(pinnedAuthority, TRUST_RECORD_CONTEXT, a),
			witness: await signEnvelope(pinnedWitness, TRUST_RECORD_CONTEXT, b),
		});
		expect(rule(acceptTrust(pinned, envelope))).toBe("payload");
	});

	it("rejects a record missing either signature, or with no keys", async () => {
		const full = await witnessed(
			trustRecord(6, pinnedKeys),
			pinnedAuthority,
			pinnedWitness,
		);
		expect(
			acceptTrust(
				pinned,
				create(WitnessedEnvelopeSchema, { authority: full.authority }),
			).ok,
		).toBe(false);
		expect(
			acceptTrust(
				pinned,
				create(WitnessedEnvelopeSchema, { witness: full.witness }),
			).ok,
		).toBe(false);
		const empty = trustRecord(6, { authority: [], witness: [] });
		expect(
			rule(
				acceptTrust(
					pinned,
					await witnessed(empty, pinnedAuthority, pinnedWitness),
				),
			),
		).toBe("keys");
	});

	it("pins a first record only when it is signed by its own listed keys", async () => {
		const first = trustRecord(1, pinnedKeys);
		expect(
			acceptTrust(
				undefined,
				await witnessed(first, pinnedAuthority, pinnedWitness),
			).ok,
		).toBe(true);
		expect(
			acceptTrust(
				undefined,
				await witnessed(first, rogueAuthority, pinnedWitness),
			).ok,
		).toBe(false);
		expect(
			acceptTrust(
				undefined,
				await witnessed(first, pinnedAuthority, rogueWitness),
			).ok,
		).toBe(false);
	});

	it("chains: a record accepted under the old pin becomes the pin for the next", async () => {
		const second = trustRecord(6, rogue);
		const accepted = acceptTrust(
			pinned,
			await witnessed(second, pinnedAuthority, pinnedWitness),
		);
		if (!accepted.ok) throw new Error(accepted.error.message);
		const third = trustRecord(7, pinnedKeys);
		expect(
			acceptTrust(
				accepted.value,
				await witnessed(third, pinnedAuthority, pinnedWitness),
			).ok,
		).toBe(false);
		expect(
			acceptTrust(
				accepted.value,
				await witnessed(third, rogueAuthority, rogueWitness),
			).ok,
		).toBe(true);
	});

	it("refuses a payload that is not a trust record", async () => {
		const junk = new Uint8Array([0xff, 0xff, 0xff]);
		const envelope = create(WitnessedEnvelopeSchema, {
			authority: await signEnvelope(
				pinnedAuthority,
				TRUST_RECORD_CONTEXT,
				junk,
			),
			witness: await signEnvelope(pinnedWitness, TRUST_RECORD_CONTEXT, junk),
		});
		const result = acceptTrust(pinned, envelope);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("invalid-request");
	});
});
