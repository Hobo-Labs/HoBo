/**
 * The ports of `fleet-bus.ts` that the bus conformance suite does not reach:
 * the claim and order feeds read whole, the audit log, the fleet views, and
 * what each port does with a message whose subject, key or bytes do not
 * parse (dropped, never handed on). Over the in-memory wire.
 */
import { create, toBinary } from "@bufbuild/protobuf";
import {
	AUDIT_CHECKPOINT_CONTEXT,
	AuditEntrySchema,
	FLEET_VIEW_CONTEXT,
	FleetViewSchema,
	type MemberId,
	MemberState,
	parseFleetId,
	parseMemberId,
	parseWorkDigest,
	type SignedEnvelope,
	SignedEnvelopeSchema,
	TRUST_RECORD_CONTEXT,
	type WitnessedEnvelope,
	WitnessedEnvelopeSchema,
} from "@hobo/fleet";
import { signEnvelope } from "@hobo/fleet/keys";
import { describe, expect, it } from "vitest";
import { authorityBusOverWire, busOverWire } from "../src/bus/fleet-bus.js";
import { AUDIT_SUBJECTS, BUCKETS, STREAMS } from "../src/bus/names.js";
import {
	authorityPin,
	createRegistryView,
	devicePin,
} from "../src/bus/registry-view.js";
import type { BusWire } from "../src/bus/wire.js";
import { createTenant } from "./support/fixture.js";
import { createMemoryNats } from "./support/memory-wire.js";

const encoder = new TextEncoder();
const FLEET = parseFleetId("builders");
const OTHER = parseFleetId("others");
const DIGEST = parseWorkDigest("0123456789abcdef0123456789abcdef");
const MEMBER = parseMemberId(`dev_${"a".repeat(32)}`);
const SECOND = parseMemberId(`dev_${"b".repeat(32)}`);

function envelope(context: string, payload: string): SignedEnvelope {
	return create(SignedEnvelopeSchema, {
		context,
		keyId: "test#1",
		payload: encoder.encode(payload),
	});
}

const bytes = (value: SignedEnvelope) => toBinary(SignedEnvelopeSchema, value);
const garbage = new Uint8Array([0xff, 0xff, 0xff]);

function authorityOn(wire: BusWire, now = Date.now) {
	const pin = authorityPin(() => {
		throw new Error("no trust record");
	});
	return authorityBusOverWire(
		wire,
		createRegistryView({ wire, pin, now }),
		pin,
		now,
	);
}

/** Collects what `subscribe` hands on until `count` items arrive. */
function collector<T>() {
	const seen: T[] = [];
	return {
		seen,
		push: async (item: T) => {
			seen.push(item);
		},
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("the claim ledger", () => {
	it("hands on stored claims of wanted fleets and drops the rest", async () => {
		const nats = createMemoryNats();
		const wire = nats.connect();
		const bus = authorityOn(wire);
		const claim = envelope("hobo-fleet/claim/v1", "c1");
		expect(await bus.claims.claim(claim, FLEET, DIGEST)).toBe("claimed");
		expect(await bus.claims.claim(claim, FLEET, DIGEST)).toBe("held");
		await bus.claims.claim(claim, OTHER, DIGEST);
		await wire.streamPublish(
			STREAMS.claims,
			"fleet.claim.builders.NOT-HEX",
			bytes(claim),
		);
		await wire.streamPublish(
			STREAMS.claims,
			"fleet.claim.builders",
			bytes(claim),
		);
		await wire.streamPublish(
			STREAMS.claims,
			"fleet.claim.BAD!.x",
			bytes(claim),
		);
		await wire.streamPublish(
			STREAMS.claims,
			`fleet.claim.builders.${"f".repeat(32)}`,
			garbage,
		);
		const seen = collector<string>();
		const subscription = bus.claims.subscribe(
			[FLEET, parseFleetId("bad")],
			"start",
			(_claim, fleet, digest) => seen.push(`${fleet}/${digest}`),
		);
		await settle();
		await subscription.stop();
		expect(seen.seen).toEqual([`builders/${DIGEST}`]);
		expect((await bus.claims.holder(FLEET, DIGEST))?.payload).toEqual(
			claim.payload,
		);
		await bus.claims.remove(FLEET, DIGEST);
		await bus.claims.remove(FLEET, DIGEST);
		expect(await bus.claims.holder(FLEET, DIGEST)).toBeUndefined();
	});
});

describe("the order channel", () => {
	it("observes every order with its addressee, dropping unparsable subjects", async () => {
		const wire = createMemoryNats().connect();
		const bus = authorityOn(wire);
		await bus.orders.deliver(envelope("hobo-fleet/order/v1", "o1"), MEMBER);
		await wire.streamPublish(
			STREAMS.orders,
			"fleet.order.nobody",
			bytes(envelope("x", "o2")),
		);
		await wire.streamPublish(
			STREAMS.orders,
			"fleet.order.a.b",
			bytes(envelope("x", "o3")),
		);
		const seen = collector<MemberId>();
		const subscription = bus.orders.observeAll("start", (_order, to) =>
			seen.push(to),
		);
		await settle();
		await subscription.stop();
		expect(seen.seen).toEqual([MEMBER]);
	});
});

describe("feeds and channels", () => {
	it("refuses a message the stream did not store", async () => {
		const inner = createMemoryNats().connect();
		const wire: BusWire = {
			...inner,
			streamPublish: async () => "subject-full",
		};
		const bus = busOverWire(wire, authorityOn(inner).registry);
		await expect(bus.offers.publish(envelope("x", "o"), FLEET)).rejects.toThrow(
			"FLEET_OFFERS refused a message on fleet.offer.builders",
		);
	});

	it("refuses an event kind or relay session that is not one token", async () => {
		const bus = authorityOn(createMemoryNats().connect());
		await expect(async () =>
			bus.events.publish(envelope("x", "e"), MEMBER, "two.tokens"),
		).rejects.toThrow("kind must be one subject token");
		await expect(async () =>
			bus.relay.send(MEMBER, "a.b", new Uint8Array()),
		).rejects.toThrow("sessionId must be one subject token");
	});

	it("drops events from an unparsable member and relay frames of another shape", async () => {
		const wire = createMemoryNats().connect();
		const bus = authorityOn(wire);
		await wire.streamPublish(
			STREAMS.events,
			"fleet.event.nobody.started",
			bytes(envelope("x", "e")),
		);
		await bus.events.publish(envelope("x", "e2"), MEMBER, "started");
		const events = collector<string>();
		const subscription = bus.events.subscribe(
			["started"],
			"start",
			(_e, from) => events.push(from),
		);
		const frames = collector<string>();
		const relay = bus.relay.subscribe(MEMBER, (session) =>
			frames.push(session),
		);
		await wire.publish(`fleet.relay.${MEMBER}.s1.extra`, new Uint8Array());
		await bus.relay.send(MEMBER, "s2", new Uint8Array([1]));
		await settle();
		await subscription.stop();
		await relay.stop();
		expect(events.seen).toEqual([MEMBER]);
		expect(frames.seen).toEqual(["s2"]);
	});

	it("reads only well-formed observation keys holding an envelope", async () => {
		const wire = createMemoryNats().connect();
		const bus = authorityOn(wire);
		await bus.observations.publish(envelope("x", "ob"), MEMBER, SECOND);
		await wire.kvPut(
			BUCKETS.observations,
			`${MEMBER}.${SECOND}.extra`,
			bytes(envelope("x", "1")),
		);
		await wire.kvPut(
			BUCKETS.observations,
			`nobody.${SECOND}`,
			bytes(envelope("x", "2")),
		);
		await wire.kvPut(
			BUCKETS.observations,
			`${MEMBER}.nobody`,
			bytes(envelope("x", "3")),
		);
		await wire.kvPut(BUCKETS.observations, `${SECOND}.${MEMBER}`, garbage);
		const { observations, capped } = await bus.observations.read(10);
		expect(capped).toBe(false);
		expect(observations.map((o) => [o.observerId, o.memberId])).toEqual([
			[MEMBER, SECOND],
		]);
	});

	it("answers false for a replay id that has already expired", async () => {
		const bus = authorityOn(createMemoryNats().connect());
		expect(await bus.replay.firstUse("scope", "id", Date.now() - 1)).toBe(
			false,
		);
		expect(await bus.replay.firstUse("scope", "id", Date.now() + 60_000)).toBe(
			true,
		);
	});
});

describe("the audit log", () => {
	it("appends entries and reads a sequence range in order", async () => {
		const wire = createMemoryNats().connect();
		const bus = authorityOn(wire);
		for (const sequence of [3, 1, 2])
			await bus.audit.append(create(AuditEntrySchema, { sequence }));
		await wire.streamPublish(STREAMS.audit, AUDIT_SUBJECTS.entry, garbage);
		const entries = await bus.audit.entries(2, 3);
		expect(entries.map((entry) => entry.sequence)).toEqual([2, 3]);
	});

	it("pairs each witness co-signature with the authority envelope it signs", async () => {
		const wire = createMemoryNats().connect();
		const bus = authorityOn(wire);
		const checkpoints: WitnessedEnvelope[] = [];
		const trusts: WitnessedEnvelope[] = [];
		const proposed: SignedEnvelope[] = [];
		const subscriptions = [
			bus.audit.onWitnessed(async (w) => {
				checkpoints.push(w);
			}),
			bus.audit.onTrustWitnessed(async (w) => {
				trusts.push(w);
			}),
			bus.audit.onTrustProposed(async (record) => {
				proposed.push(record);
			}),
		];
		await bus.audit.appendCheckpoint(envelope(AUDIT_CHECKPOINT_CONTEXT, "cp1"));
		await bus.audit.proposeTrust(envelope(TRUST_RECORD_CONTEXT, "t1"));
		const witness = async (context: string, payload: string) =>
			wire.streamPublish(
				STREAMS.audit,
				AUDIT_SUBJECTS.witness,
				bytes(envelope(context, payload)),
			);
		await witness(AUDIT_CHECKPOINT_CONTEXT, "cp1");
		await witness(AUDIT_CHECKPOINT_CONTEXT, "unknown");
		await witness(TRUST_RECORD_CONTEXT, "t1");
		await wire.streamPublish(STREAMS.audit, AUDIT_SUBJECTS.witness, garbage);
		await settle();
		for (const subscription of subscriptions) await subscription.stop();
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0]?.authority?.context).toBe(AUDIT_CHECKPOINT_CONTEXT);
		expect(trusts).toHaveLength(1);
		expect(trusts[0]?.witness?.payload).toEqual(encoder.encode("t1"));
		expect(proposed.map((record) => record.context)).toEqual([
			TRUST_RECORD_CONTEXT,
		]);
	});
});

describe("fleet views and trust pins", () => {
	it("serves a current view signed by the authority for its own fleet only", async () => {
		const tenant = await createTenant();
		const view = async (
			fleet: string,
			notAfterMs: number,
			signer = tenant.authority,
		) =>
			signEnvelope(
				signer,
				FLEET_VIEW_CONTEXT,
				toBinary(
					FleetViewSchema,
					create(FleetViewSchema, {
						fleet,
						asOf: new Date(tenant.now()).toISOString(),
						notAfter: new Date(notAfterMs).toISOString(),
					}),
				),
			);
		const registry = tenant.bus.registry;
		expect(await registry.view(FLEET)).toBeUndefined();
		await tenant.bus.publisher.putView(
			await view("builders", tenant.now() + 60_000),
			FLEET,
		);
		expect((await registry.view(FLEET))?.fleet).toBe("builders");
		await tenant.bus.publisher.putView(
			await view("others", tenant.now() + 60_000),
			FLEET,
		);
		expect(await registry.view(FLEET)).toBeUndefined();
		await tenant.bus.publisher.putView(
			await view("builders", tenant.now() - 1),
			FLEET,
		);
		expect(await registry.view(FLEET)).toBeUndefined();
		const wire = tenant.nats.connect();
		await wire.kvPut(
			BUCKETS.views,
			"fleet.builders",
			bytes(
				create(SignedEnvelopeSchema, {
					context: FLEET_VIEW_CONTEXT,
					payload: garbage,
					keyId: "authority#1",
				}),
			),
		);
		expect(await registry.view(FLEET)).toBeUndefined();
		await wire.kvPut(BUCKETS.views, "fleet.builders", garbage);
		expect(await registry.view(FLEET)).toBeUndefined();
	});

	it("keeps a device pin on a refused trust record and logs it", async () => {
		const tenant = await createTenant();
		const logged: unknown[] = [];
		const pin = devicePin(tenant.trust, (event, fields) =>
			logged.push([event, fields]),
		);
		const unwitnessed = create(WitnessedEnvelopeSchema, {
			authority: tenant.trust.authority,
		});
		pin.offer(unwitnessed, "bus");
		expect(pin.envelope()).toBe(tenant.trust);
		expect(logged).toEqual([
			[
				"hobo_fleet_bus_status",
				{
					trust: "refused",
					reason: "a trust record needs an authority and a witness signature",
				},
			],
		]);
		const replayed = { ...tenant.trust };
		pin.offer(replayed, "bus");
		expect(logged).toHaveLength(1);
		pin.offer(tenant.trust, "bus");
		expect(pin.record().tenant).toBe("acme");
		expect(() => devicePin(unwitnessed, () => undefined)).toThrow(
			/the pinned trust record is unusable/u,
		);
	});

	it("ignores an own trust envelope without a decodable authority payload", () => {
		const pin = authorityPin(() => {
			throw new Error("no trust record");
		});
		pin.offer(create(WitnessedEnvelopeSchema), "own");
		expect(pin.envelope()).toBeUndefined();
	});

	it("drops a member record of the wrong id or tenant", async () => {
		const tenant = await createTenant();
		const keys = await tenant.device({ tenant: "other" });
		expect(await tenant.bus.registry.member(keys.memberId)).toBeUndefined();
		const mine = await tenant.device({ state: MemberState.ACTIVE });
		const wire = tenant.nats.connect();
		const stored = await wire.kvGet(
			BUCKETS.registry,
			`member.${mine.memberId}`,
		);
		await wire.kvPut(BUCKETS.registry, `member.${MEMBER}`, stored ?? garbage);
		expect(await tenant.bus.registry.member(MEMBER)).toBeUndefined();
	});
});
