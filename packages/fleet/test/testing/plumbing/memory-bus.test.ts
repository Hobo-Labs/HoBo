import { create, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import type { WitnessedEnvelope } from "../../../src/_generated/fleet_pb.js";
import {
	AuditEntrySchema,
	FleetRecordSchema,
	FleetViewSchema,
	MemberRecordSchema,
	MembershipSchema,
	type SignedEnvelope,
	SignedEnvelopeSchema,
	TrustRecordSchema,
	WitnessedEnvelopeSchema,
} from "../../../src/_generated/fleet_pb.js";
import {
	AUDIT_CHECKPOINT_CONTEXT,
	CLAIM_CONTEXT,
	FLEET_RECORD_CONTEXT,
	FLEET_VIEW_CONTEXT,
	MEMBER_RECORD_CONTEXT,
	OFFER_CONTEXT,
	TRUST_RECORD_CONTEXT,
} from "../../../src/contexts.js";
import {
	type FleetId,
	type MemberId,
	parseFleetId,
	parseMemberId,
	parseWorkDigest,
} from "../../../src/ids.js";
import {
	createMemoryBus,
	publishWitnessCosignature,
} from "../../../src/testing/plumbing/memory-bus.js";

const T0 = Date.parse("2026-11-12T10:00:00Z");
const MEMBER_A = parseMemberId(`dev_${"a".repeat(32)}`);
const MEMBER_B = parseMemberId(`dev_${"b".repeat(32)}`);
const FLEET = parseFleetId("hobo");
const OTHER_FLEET = parseFleetId("laptops");
const DIGEST = parseWorkDigest("0".repeat(32));

function clock(start = T0) {
	let current = start;
	return {
		now: () => current,
		advance(ms: number) {
			current += ms;
		},
	};
}

async function settle(): Promise<void> {
	for (let round = 0; round < 5; round += 1)
		await new Promise<void>((resolve) => setImmediate(resolve));
}

function envelope(context: string, payload: Uint8Array): SignedEnvelope {
	return create(SignedEnvelopeSchema, {
		context,
		keyId: "authority#1",
		payload,
		signature: new Uint8Array([1, 2, 3]),
	});
}

function opaque(context: string, marker: number): SignedEnvelope {
	return envelope(context, new Uint8Array([marker]));
}

function memberEnvelope(
	id: MemberId,
	recordSequence: number,
	notAfterMs: number,
	fleet: FleetId = FLEET,
): SignedEnvelope {
	return envelope(
		MEMBER_RECORD_CONTEXT,
		toBinary(
			MemberRecordSchema,
			create(MemberRecordSchema, {
				memberId: id,
				tenant: "test",
				recordSequence,
				notAfter: new Date(notAfterMs).toISOString(),
				memberships: [create(MembershipSchema, { fleet, name: "box" })],
			}),
		),
	);
}

function fleetEnvelope(
	id: FleetId,
	revision: number,
	notAfterMs: number,
): SignedEnvelope {
	return envelope(
		FLEET_RECORD_CONTEXT,
		toBinary(
			FleetRecordSchema,
			create(FleetRecordSchema, {
				fleetId: id,
				tenant: "test",
				revision,
				notAfter: new Date(notAfterMs).toISOString(),
			}),
		),
	);
}

function trustEnvelope(sequence: number): WitnessedEnvelope {
	const payload = toBinary(
		TrustRecordSchema,
		create(TrustRecordSchema, { tenant: "test", sequence }),
	);
	return create(WitnessedEnvelopeSchema, {
		authority: envelope(TRUST_RECORD_CONTEXT, payload),
		witness: envelope(TRUST_RECORD_CONTEXT, payload),
	});
}

describe("createMemoryBus registry view", () => {
	it("decodes member and fleet records without verifying signatures", async () => {
		const time = clock();
		const bus = createMemoryBus(time.now);
		await bus.publisher.putMember(
			memberEnvelope(MEMBER_A, 1, T0 + 60_000),
			MEMBER_A,
		);
		await bus.publisher.putFleet(fleetEnvelope(FLEET, 1, T0 + 60_000), FLEET);

		expect((await bus.registry.member(MEMBER_A))?.memberId).toBe(MEMBER_A);
		expect((await bus.registry.fleet(FLEET))?.fleetId).toBe(FLEET);
		expect((await bus.registry.members()).map((m) => m.memberId)).toEqual([
			MEMBER_A,
		]);
		expect((await bus.registry.fleets()).map((f) => f.fleetId)).toEqual([
			FLEET,
		]);
		expect((await bus.registry.membersOf(FLEET)).length).toBe(1);
		expect(await bus.registry.membersOf(OTHER_FLEET)).toEqual([]);
		expect(await bus.registry.member(MEMBER_B)).toBeUndefined();
		await expect(bus.registry.caughtUp()).resolves.toBeUndefined();
	});

	it("refuses a record past its not_after", async () => {
		const time = clock();
		const bus = createMemoryBus(time.now);
		await bus.publisher.putMember(
			memberEnvelope(MEMBER_A, 1, T0 + 1_000),
			MEMBER_A,
		);
		await bus.publisher.putFleet(fleetEnvelope(FLEET, 1, T0 + 1_000), FLEET);
		expect(await bus.registry.member(MEMBER_A)).toBeDefined();
		time.advance(1_001);
		expect(await bus.registry.member(MEMBER_A)).toBeUndefined();
		expect(await bus.registry.fleet(FLEET)).toBeUndefined();
		expect(await bus.registry.members()).toEqual([]);
	});

	it("refuses a record whose sequence is lower than the highest it returned for that key", async () => {
		const bus = createMemoryBus(clock().now);
		await bus.publisher.putMember(
			memberEnvelope(MEMBER_A, 5, T0 + 60_000),
			MEMBER_A,
		);
		expect((await bus.registry.member(MEMBER_A))?.recordSequence).toBe(5);
		await bus.publisher.putMember(
			memberEnvelope(MEMBER_A, 4, T0 + 60_000),
			MEMBER_A,
		);
		expect(await bus.registry.member(MEMBER_A)).toBeUndefined();
		await bus.publisher.putMember(
			memberEnvelope(MEMBER_A, 5, T0 + 90_000),
			MEMBER_A,
		);
		expect((await bus.registry.member(MEMBER_A))?.recordSequence).toBe(5);

		await bus.publisher.putFleet(fleetEnvelope(FLEET, 3, T0 + 60_000), FLEET);
		expect((await bus.registry.fleet(FLEET))?.revision).toBe(3);
		await bus.publisher.putFleet(fleetEnvelope(FLEET, 2, T0 + 60_000), FLEET);
		expect(await bus.registry.fleet(FLEET)).toBeUndefined();
	});

	it("refuses a record under the wrong context or key", async () => {
		const bus = createMemoryBus(clock().now);
		const record = memberEnvelope(MEMBER_A, 1, T0 + 60_000);
		await bus.publisher.putMember(record, MEMBER_B);
		expect(await bus.registry.member(MEMBER_B)).toBeUndefined();
		await bus.publisher.putMember(
			envelope(FLEET_RECORD_CONTEXT, record.payload),
			MEMBER_A,
		);
		expect(await bus.registry.member(MEMBER_A)).toBeUndefined();
		await bus.publisher.putMember(
			opaque(MEMBER_RECORD_CONTEXT, 0xff),
			MEMBER_A,
		);
		expect(await bus.registry.member(MEMBER_A)).toBeUndefined();
	});

	it("serves fleet views until their not_after", async () => {
		const time = clock();
		const bus = createMemoryBus(time.now);
		const view = create(FleetViewSchema, {
			fleet: FLEET,
			notAfter: new Date(T0 + 120_000).toISOString(),
		});
		await bus.publisher.putView(
			envelope(FLEET_VIEW_CONTEXT, toBinary(FleetViewSchema, view)),
			FLEET,
		);
		expect((await bus.registry.view(FLEET))?.fleet).toBe(FLEET);
		time.advance(120_001);
		expect(await bus.registry.view(FLEET)).toBeUndefined();
	});

	it("returns an empty trust record until one is published, then never goes back", async () => {
		const bus = createMemoryBus(clock().now);
		expect(bus.registry.trust().sequence).toBe(0);
		expect(bus.registry.trust().authorityKeys).toEqual([]);
		expect(bus.registry.trustEnvelope()).toBeUndefined();
		await bus.publisher.putTrust(trustEnvelope(2));
		expect(bus.registry.trust().sequence).toBe(2);
		expect(bus.registry.trustEnvelope()).toBeDefined();
		await bus.publisher.putTrust(trustEnvelope(1));
		expect(bus.registry.trust().sequence).toBe(2);
		await bus.publisher.putTrust(trustEnvelope(3));
		expect(bus.registry.trust().sequence).toBe(3);
	});
});

describe("createMemoryBus claim ledger", () => {
	it("refuses a second writer, and frees the subject after expiry or removal", async () => {
		const time = clock();
		const bus = createMemoryBus(time.now);
		const first = opaque(CLAIM_CONTEXT, 1);
		const second = opaque(CLAIM_CONTEXT, 2);
		expect(await bus.claims.claim(first, FLEET, DIGEST)).toBe("claimed");
		expect(await bus.claims.claim(second, FLEET, DIGEST)).toBe("held");
		expect((await bus.claims.holder(FLEET, DIGEST))?.payload).toEqual(
			first.payload,
		);
		expect(await bus.claims.claim(second, OTHER_FLEET, DIGEST)).toBe("claimed");

		time.advance(120_000);
		expect(await bus.claims.holder(FLEET, DIGEST)).toBeUndefined();
		expect(await bus.claims.claim(second, FLEET, DIGEST)).toBe("claimed");

		await bus.claims.remove(FLEET, DIGEST);
		expect(await bus.claims.holder(FLEET, DIGEST)).toBeUndefined();
		expect(await bus.claims.claim(first, FLEET, DIGEST)).toBe("claimed");
	});

	it("streams claims of the subscribed fleets in order with sequences", async () => {
		const bus = createMemoryBus(clock().now);
		const seen: Array<[string, number]> = [];
		const subscription = bus.claims.subscribe(
			[FLEET],
			"start",
			async (_c, fleet, _d, sequence) => {
				seen.push([fleet, sequence]);
			},
		);
		await bus.claims.claim(opaque(CLAIM_CONTEXT, 1), FLEET, DIGEST);
		await bus.claims.claim(opaque(CLAIM_CONTEXT, 2), OTHER_FLEET, DIGEST);
		await bus.claims.claim(
			opaque(CLAIM_CONTEXT, 3),
			FLEET,
			parseWorkDigest("1".repeat(32)),
		);
		await settle();
		expect(seen).toEqual([
			[FLEET, 1],
			[FLEET, 3],
		]);
		await subscription.stop();
	});
});

describe("createMemoryBus streams", () => {
	it("honours BusStart: start, new and after", async () => {
		const bus = createMemoryBus(clock().now);
		await bus.offers.publish(opaque(OFFER_CONTEXT, 1), FLEET);
		await bus.offers.publish(opaque(OFFER_CONTEXT, 2), FLEET);
		const fromStart: number[] = [];
		const fromNew: number[] = [];
		const fromAfter: number[] = [];
		bus.offers.subscribe([FLEET], "start", async (_o, sequence) => {
			fromStart.push(sequence);
		});
		bus.offers.subscribe([FLEET], "new", async (_o, sequence) => {
			fromNew.push(sequence);
		});
		bus.offers.subscribe([FLEET], { after: 1 }, async (_o, sequence) => {
			fromAfter.push(sequence);
		});
		await bus.offers.publish(opaque(OFFER_CONTEXT, 3), FLEET);
		await settle();
		expect(fromStart).toEqual([1, 2, 3]);
		expect(fromNew).toEqual([3]);
		expect(fromAfter).toEqual([2, 3]);
	});

	it("keeps order even when a handler is slow", async () => {
		const bus = createMemoryBus(clock().now);
		const seen: number[] = [];
		bus.submissions.subscribe([FLEET], "new", async (submission) => {
			const marker = submission.payload[0] ?? 0;
			if (marker === 1) await settle();
			seen.push(marker);
		});
		for (const marker of [1, 2, 3])
			await bus.submissions.publish(opaque(OFFER_CONTEXT, marker), FLEET);
		await settle();
		await settle();
		expect(seen).toEqual([1, 2, 3]);
	});

	it("drops messages past the stream's maximum age from a replay", async () => {
		const time = clock();
		const bus = createMemoryBus(time.now);
		await bus.offers.publish(opaque(OFFER_CONTEXT, 1), FLEET);
		time.advance(15 * 60_000);
		await bus.offers.publish(opaque(OFFER_CONTEXT, 2), FLEET);
		const seen: number[] = [];
		bus.offers.subscribe([FLEET], "start", async (_o, sequence) => {
			seen.push(sequence);
		});
		await settle();
		expect(seen).toEqual([2]);
	});

	it("delivers orders and control only to their member, and every order to observeAll", async () => {
		const bus = createMemoryBus(clock().now);
		const toA: number[] = [];
		const all: Array<[string, number]> = [];
		const controlA: number[] = [];
		bus.orders.subscribe(MEMBER_A, "start", async (_o, sequence) => {
			toA.push(sequence);
		});
		bus.orders.observeAll("start", async (_o, to, sequence) => {
			all.push([to, sequence]);
		});
		bus.control.subscribe(MEMBER_A, "start", async (_c, sequence) => {
			controlA.push(sequence);
		});
		await bus.orders.deliver(opaque(OFFER_CONTEXT, 1), MEMBER_A);
		await bus.orders.deliver(opaque(OFFER_CONTEXT, 2), MEMBER_B);
		await bus.control.send(opaque(OFFER_CONTEXT, 1), MEMBER_B);
		await bus.control.send(opaque(OFFER_CONTEXT, 2), MEMBER_A);
		await settle();
		expect(toA).toEqual([1]);
		expect(all).toEqual([
			[MEMBER_A, 1],
			[MEMBER_B, 2],
		]);
		expect(controlA).toEqual([2]);
	});

	it("filters events by kind and reports the sender", async () => {
		const bus = createMemoryBus(clock().now);
		const seen: Array<[string, string, number]> = [];
		bus.events.subscribe(
			["receipt"],
			"start",
			async (_e, member, kind, sequence) => {
				seen.push([member, kind, sequence]);
			},
		);
		await bus.events.publish(opaque(OFFER_CONTEXT, 1), MEMBER_A, "log");
		await bus.events.publish(opaque(OFFER_CONTEXT, 2), MEMBER_A, "receipt");
		await settle();
		expect(seen).toEqual([[MEMBER_A, "receipt", 2]]);
	});

	it("stops delivering after stop() and after close()", async () => {
		const bus = createMemoryBus(clock().now);
		const seen: number[] = [];
		const subscription = bus.offers.subscribe(
			[FLEET],
			"new",
			async (_o, sequence) => {
				seen.push(sequence);
			},
		);
		await bus.offers.publish(opaque(OFFER_CONTEXT, 1), FLEET);
		await settle();
		await subscription.stop();
		await bus.offers.publish(opaque(OFFER_CONTEXT, 2), FLEET);
		await settle();
		expect(seen).toEqual([1]);
		expect(bus.status()).toBe("connected");
		await bus.close();
		expect(bus.status()).toBe("closed");
		await expect(
			bus.offers.publish(opaque(OFFER_CONTEXT, 3), FLEET),
		).rejects.toThrow(/closed/);
	});

	it("relays frames only to live subscribers of the addressee", async () => {
		const bus = createMemoryBus(clock().now);
		const frames: string[] = [];
		const subscription = bus.relay.subscribe(
			MEMBER_A,
			async (sessionId, frame) => {
				frames.push(`${sessionId}:${frame.join(",")}`);
			},
		);
		await bus.relay.send(MEMBER_A, "s1", new Uint8Array([1, 2]));
		await bus.relay.send(MEMBER_B, "s1", new Uint8Array([3]));
		await settle();
		await subscription.stop();
		await bus.relay.send(MEMBER_A, "s2", new Uint8Array([4]));
		await settle();
		expect(frames).toEqual(["s1:1,2"]);
	});
});

describe("createMemoryBus observations and replay", () => {
	it("keeps the latest observation per observer and member for 60 s", async () => {
		const time = clock();
		const bus = createMemoryBus(time.now);
		await bus.observations.publish(
			opaque(OFFER_CONTEXT, 1),
			MEMBER_A,
			MEMBER_A,
		);
		await bus.observations.publish(
			opaque(OFFER_CONTEXT, 2),
			MEMBER_A,
			MEMBER_A,
		);
		time.advance(30_000);
		await bus.observations.publish(
			opaque(OFFER_CONTEXT, 3),
			MEMBER_B,
			MEMBER_B,
		);
		let read = await bus.observations.read(10);
		expect(read.capped).toBe(false);
		expect(read.observations.map((o) => o.envelope.payload[0])).toEqual([2, 3]);
		expect(read.observations[0]?.observerId).toBe(MEMBER_A);

		expect((await bus.observations.read(1)).capped).toBe(true);

		time.advance(30_000);
		read = await bus.observations.read(10);
		expect(read.observations.map((o) => o.memberId)).toEqual([MEMBER_B]);
	});

	it("answers firstUse once per id until its expiry", async () => {
		const time = clock();
		const bus = createMemoryBus(time.now);
		expect(await bus.replay.firstUse("dpop", "j1", T0 + 1_000)).toBe(true);
		expect(await bus.replay.firstUse("dpop", "j1", T0 + 1_000)).toBe(false);
		expect(await bus.replay.firstUse("oidc", "j1", T0 + 1_000)).toBe(true);
		time.advance(1_000);
		expect(await bus.replay.firstUse("dpop", "j1", T0 + 5_000)).toBe(true);
	});
});

describe("createMemoryBus audit log", () => {
	it("returns entries in a sequence range", async () => {
		const bus = createMemoryBus(clock().now);
		for (const sequence of [2, 1, 3])
			await bus.audit.append(
				create(AuditEntrySchema, { sequence, eventType: "fleet.X" }),
			);
		const entries = await bus.audit.entries(1, 2);
		expect(entries.map((e) => e.sequence)).toEqual([1, 2]);
	});

	it("pairs a witness co-signature with the checkpoint or trust record it signs", async () => {
		const bus = createMemoryBus(clock().now);
		const witnessed: WitnessedEnvelope[] = [];
		const proposed: SignedEnvelope[] = [];
		const trusted: WitnessedEnvelope[] = [];
		bus.audit.onWitnessed(async (checkpoint) => {
			witnessed.push(checkpoint);
		});
		bus.audit.onTrustProposed(async (record) => {
			proposed.push(record);
		});
		bus.audit.onTrustWitnessed(async (trust) => {
			trusted.push(trust);
		});

		const checkpoint = opaque(AUDIT_CHECKPOINT_CONTEXT, 7);
		await bus.audit.appendCheckpoint(checkpoint);
		await publishWitnessCosignature(
			bus,
			create(SignedEnvelopeSchema, {
				context: AUDIT_CHECKPOINT_CONTEXT,
				keyId: "witness#1",
				payload: new Uint8Array([7]),
			}),
			"checkpoint",
		);
		const trust = opaque(TRUST_RECORD_CONTEXT, 9);
		// A co-signature that arrives first waits for its record.
		await publishWitnessCosignature(
			bus,
			create(SignedEnvelopeSchema, {
				context: TRUST_RECORD_CONTEXT,
				keyId: "witness#1",
				payload: new Uint8Array([9]),
			}),
			"trust",
		);
		await bus.audit.proposeTrust(trust);
		await settle();

		expect(
			witnessed.map((w) => [w.authority?.keyId, w.witness?.keyId]),
		).toEqual([["authority#1", "witness#1"]]);
		expect(proposed.map((p) => p.payload[0])).toEqual([9]);
		expect(trusted.map((t) => t.witness?.payload[0])).toEqual([9]);
	});
});
