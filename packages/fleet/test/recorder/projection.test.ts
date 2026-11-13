// O30 (projection half): the registry rebuilt from the journal, signed with
// a bounded lifetime, re-signed before expiry with its sequence unchanged,
// fleet views every 30 s, member-hours once per hour, and a rebuild from an
// empty bus gives back the same records and sequences.
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	FleetRecordSchema,
	FleetViewSchema,
	Health,
	MemberRecordSchema,
	MemberState,
	ObservationSchema,
	ReliabilitySamplesSchema,
} from "../../src/_generated/fleet_pb.js";
import {
	FLEET_RECORD_CONTEXT,
	FLEET_VIEW_CONTEXT,
	MEMBER_RECORD_CONTEXT,
	OBSERVATION_CONTEXT,
} from "../../src/contexts.js";
import { type MemberId, parseMemberId } from "../../src/ids.js";
import { signEnvelope, verifyEnvelope } from "../../src/keys/index.js";
import type { AuthorityBus } from "../../src/ports.js";
import { createRegistryProjection } from "../../src/recorder/index.js";
import {
	appendAs,
	type Device,
	device,
	FLEET,
	fleetEvent,
	fleetRecord,
	freshBus,
	iso,
	memberEvent,
	Role,
	START,
	settle,
	TENANT,
	type World,
	world,
} from "./fixtures.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function projectionOf(
	at: World,
	bus: AuthorityBus = at.bus,
	reliability = new Map<MemberId, ReturnType<typeof samples>>(),
) {
	return createRegistryProjection({
		tenant: TENANT,
		store: at.store,
		bus,
		recordSigner: at.authority.signer,
		incarnation: 3,
		metering: at.metering,
		now: at.clock,
		log: at.log,
		reliability: () => reliability,
	});
}

function samples(delivered: number, dropped: number) {
	return create(ReliabilitySamplesSchema, { delivered, dropped });
}

async function journal(at: World): Promise<Device> {
	const box = await device([Role.EXECUTOR], "box");
	await appendAs(at.store, `fleet-fleet-${FLEET}`, [
		fleetEvent("fleet.FleetDefined", fleetRecord(1)),
	]);
	await appendAs(at.store, `fleet-member-${box.keys.memberId}`, [
		memberEvent(
			"fleet.EnrollmentRequested",
			create(MemberRecordSchema, {
				...box.record,
				state: MemberState.PENDING,
				recordSequence: 1,
			}),
		),
		memberEvent(
			"fleet.MemberActivated",
			create(MemberRecordSchema, { ...box.record, recordSequence: 2 }),
		),
	]);
	return box;
}

/** What the registry serves for the device and the fleet. */
async function served(bus: AuthorityBus, box: Device) {
	const member = await bus.registry.member(parseMemberId(box.keys.memberId));
	const fleet = await bus.registry.fleet(FLEET);
	return { member, fleet };
}

/** A record without its signing-time fields: what must survive a rebuild. */
function content<T extends { issuedAt: string; notAfter: string }>(
	record: T | undefined,
) {
	if (record === undefined) return undefined;
	return { ...record, issuedAt: "", notAfter: "" };
}

describe("createRegistryProjection", () => {
	it("rebuilds member and fleet records from the journal and signs them for at most 30 minutes", async () => {
		const at = await world();
		const box = await journal(at);
		const projection = projectionOf(at);
		await projection.tick();
		const { member, fleet } = await served(at.bus, box);
		expect(member?.recordSequence).toBe(2);
		expect(member?.state).toBe(MemberState.ACTIVE);
		expect(member?.authorityIncarnation).toBe(3);
		expect(member?.issuedAt).toBe(iso(START));
		expect(
			Date.parse(member?.notAfter ?? "") - Date.parse(member?.issuedAt ?? ""),
		).toBeLessThanOrEqual(30 * MINUTE);
		expect(fleet?.revision).toBe(1);
		expect(
			Date.parse(fleet?.notAfter ?? "") - Date.parse(fleet?.issuedAt ?? ""),
		).toBeLessThanOrEqual(30 * MINUTE);
	});

	it("publishes a fleet record as soon as it is defined, before any enrollment into it", async () => {
		const at = await world();
		const projection = projectionOf(at);
		await projection.caughtUp();
		expect(await at.bus.registry.fleet(FLEET)).toBeUndefined();
		await appendAs(at.store, `fleet-fleet-${FLEET}`, [
			fleetEvent("fleet.FleetDefined", fleetRecord(1)),
		]);
		await settle(at.store);
		expect((await at.bus.registry.fleet(FLEET))?.revision).toBe(1);
		// caughtUp also answers only once the change is on the bus.
		await appendAs(at.store, `fleet-fleet-${FLEET}`, [
			fleetEvent("fleet.FleetPolicyChanged", fleetRecord(2, ["hobo", "gpu"])),
		]);
		await projection.caughtUp();
		const fleet = await at.bus.registry.fleet(FLEET);
		expect(fleet?.revision).toBe(2);
		expect(fleet?.policy?.labels).toEqual(["hobo", "gpu"]);
	});

	it("never serves a record past its not_after: it re-signs before expiry and keeps the sequence", async () => {
		const at = await world();
		const box = await journal(at);
		const projection = projectionOf(at);
		const issued = new Set<string>();
		for (let minute = 0; minute <= 120; minute += 1) {
			await projection.tick();
			const { member, fleet } = await served(at.bus, box);
			expect(member).toBeDefined();
			expect(fleet).toBeDefined();
			expect(member?.recordSequence).toBe(2);
			expect(fleet?.revision).toBe(1);
			for (const record of [member, fleet]) {
				const notAfter = Date.parse(record?.notAfter ?? "");
				expect(notAfter).toBeGreaterThan(at.clock());
				expect(
					notAfter - Date.parse(record?.issuedAt ?? ""),
				).toBeLessThanOrEqual(30 * MINUTE);
			}
			issued.add(member?.issuedAt ?? "");
			at.clock.advance(MINUTE);
		}
		// Re-signed every 10 minutes: 13 signings in two hours.
		expect(issued.size).toBe(13);
	});

	it("publishes a content change with its new sequence", async () => {
		const at = await world();
		const box = await journal(at);
		const projection = projectionOf(at);
		await projection.tick();
		await appendAs(at.store, `fleet-member-${box.keys.memberId}`, [
			memberEvent(
				"fleet.MemberSuspended",
				create(MemberRecordSchema, {
					...box.record,
					state: MemberState.SUSPENDED,
					recordSequence: 3,
				}),
			),
		]);
		at.clock.advance(1_000);
		await projection.tick();
		const { member } = await served(at.bus, box);
		expect(member?.recordSequence).toBe(3);
		expect(member?.state).toBe(MemberState.SUSPENDED);
	});

	it("after deleting fleet-registry and fleet-views, a rebuild gives the same records and sequences", async () => {
		const at = await world();
		const box = await journal(at);
		await appendAs(at.store, `fleet-member-${box.keys.memberId}`, [
			memberEvent(
				"fleet.KeysRotated",
				create(MemberRecordSchema, { ...box.record, recordSequence: 3 }),
			),
		]);
		const before = projectionOf(at);
		await before.tick();
		const first = await served(at.bus, box);
		const firstView = await at.bus.registry.view(FLEET);
		expect(firstView).toBeDefined();

		at.clock.advance(5 * MINUTE);
		const emptied = await freshBus(at);
		expect(
			await emptied.registry.member(parseMemberId(box.keys.memberId)),
		).toBeUndefined();
		const rebuilt = projectionOf(at, emptied);
		await rebuilt.tick();
		const second = await served(emptied, box);
		expect(content(second.member)).toEqual(content(first.member));
		expect(content(second.fleet)).toEqual(content(first.fleet));
		expect(second.member?.recordSequence).toBe(3);
		const secondView = await emptied.registry.view(FLEET);
		expect(secondView?.members.map((entry) => entry.memberId)).toEqual(
			firstView?.members.map((entry) => entry.memberId),
		);
	});

	it("builds, signs and publishes fleet views every 30 seconds with the measured reliability", async () => {
		const at = await world();
		const box = await journal(at);
		const reliability = new Map([
			[parseMemberId(box.keys.memberId), samples(3, 1)],
		]);
		const puts: string[] = [];
		const bus: AuthorityBus = {
			...at.bus,
			publisher: {
				...at.bus.publisher,
				async putMember(record, id) {
					expect(
						verifyEnvelope(record, MEMBER_RECORD_CONTEXT, at.authority.ref),
					).toBe(true);
					await at.bus.publisher.putMember(record, id);
				},
				async putView(view, id) {
					expect(
						verifyEnvelope(view, FLEET_VIEW_CONTEXT, at.authority.ref),
					).toBe(true);
					const decoded = fromBinary(FleetViewSchema, view.payload);
					puts.push(decoded.asOf);
					await at.bus.publisher.putView(view, id);
				},
				async putFleet(record, id) {
					expect(
						verifyEnvelope(record, FLEET_RECORD_CONTEXT, at.authority.ref),
					).toBe(true);
					expect(fromBinary(FleetRecordSchema, record.payload).fleetId).toBe(
						id,
					);
					await at.bus.publisher.putFleet(record, id);
				},
			},
		};
		const projection = projectionOf(at, bus, reliability);
		await projection.tick();
		const report = async () => {
			// The device reports itself; the view uses the verified observation.
			await at.bus.observations.publish(
				await signEnvelope(
					box.keys.sign,
					OBSERVATION_CONTEXT,
					toBinary(
						ObservationSchema,
						create(ObservationSchema, {
							memberId: box.keys.memberId,
							observerId: box.keys.memberId,
							fleets: [FLEET],
							health: Health.REACHABLE,
							capacity: { freeSlots: 2 },
							labels: ["hobo"],
							issuedAt: iso(at.clock()),
							validUntil: iso(at.clock() + 2 * MINUTE),
						}),
					),
				),
				parseMemberId(box.keys.memberId),
				parseMemberId(box.keys.memberId),
			);
		};
		for (let second = 1; second <= 60; second += 1) {
			at.clock.advance(1_000);
			// The device reports itself; the view uses the verified observation.
			if (second === 10) await report();
			await projection.tick();
		}
		expect(puts).toEqual([
			iso(START),
			iso(START + 30_000),
			iso(START + 60_000),
		]);
		const view = await at.bus.registry.view(FLEET);
		const entry = view?.members.find(
			(candidate) => candidate.memberId === box.keys.memberId,
		);
		expect(entry?.samples?.delivered).toBe(3);
		expect(entry?.reliability).toBeCloseTo((3 + 4) / (3 + 1 + 4));
		expect(entry?.health).toBe(Health.REACHABLE);
		expect(view?.capacity?.freeSlots).toBe(2);
	});

	it("emits fleet.member.active once per member per completed hour while the member is active", async () => {
		const at = await world();
		const box = await journal(at);
		const idle = await device([Role.EXECUTOR], "idle");
		await appendAs(at.store, `fleet-member-${idle.keys.memberId}`, [
			memberEvent(
				"fleet.MemberSuspended",
				create(MemberRecordSchema, {
					...idle.record,
					state: MemberState.SUSPENDED,
					recordSequence: 1,
				}),
			),
		]);
		const projection = projectionOf(at);
		// Start half an hour before the boundary; tick each minute for 2.5 hours.
		at.clock.ms = START - 30 * MINUTE;
		for (let minute = 0; minute <= 150; minute += 1) {
			await projection.tick();
			at.clock.advance(MINUTE);
		}
		const active = at.usage.filter(
			(event) => event.eventType === "fleet.member.active",
		);
		expect(active.map((event) => event.resource)).toEqual([
			box.keys.memberId,
			box.keys.memberId,
			box.keys.memberId,
		]);
		expect(active.map((event) => event.metadata?.hour)).toEqual([
			iso(START - HOUR),
			iso(START),
			iso(START + HOUR),
		]);
		expect(active.map((event) => event.quantity)).toEqual([0.5, 1, 1]);
		expect(new Set(active.map((event) => event.metadata?.usageKey)).size).toBe(
			3,
		);
	});
});
