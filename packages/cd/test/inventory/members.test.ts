// L19 Camp mapper: every Camp of a mapped Yard is backed by a fleet member
// (a DEVICE when a reconciler serves it, else a TARGET the Station declared).
// The member's lifecycle reaches the inventory as the automatic NO_PLACE taint
// `hobo.cd/member-inactive`; reachability stays with the signal sources (D11).
import { create } from "@bufbuild/protobuf";
import {
	Availability,
	FleetMemberViewSchema,
	FleetViewSchema,
	MemberKind,
	type MemberRecord,
	MemberRecordSchema,
	MemberState,
	MembershipSchema,
} from "@hobo/fleet";
import { describe, expect, it } from "vitest";
import {
	CampConditionType,
	type CampStatusRecord,
	ConditionStatus,
	SignalSource,
	TaintEffect,
} from "../../src/_generated/cd_pb.js";
import {
	AUTO_TAINTS,
	type CampMembers,
	campMemberName,
	createCampInventory,
} from "../../src/inventory/index.js";
import {
	camp,
	clock,
	context,
	FakeAuthorizer,
	FakeDesired,
	FakeRails,
	FakeTopology,
	MemoryEventStore,
	RecordingTelemetry,
	STATION,
	TENANT,
	topology,
} from "./fakes.js";

const FLEET = "yard-a";

function member(
	id: string,
	name: string,
	state: MemberState,
	kind = MemberKind.TARGET,
): MemberRecord {
	return create(MemberRecordSchema, {
		memberId: id,
		tenant: TENANT,
		kind,
		displayName: name,
		state,
		memberships: [create(MembershipSchema, { fleet: FLEET, name })],
	});
}

function registry(records: MemberRecord[], lost: readonly string[] = []) {
	const members: CampMembers = {
		registry: {
			async membersOf(fleet) {
				return fleet === FLEET ? records : [];
			},
			async view(fleet) {
				if (fleet !== FLEET) return undefined;
				return create(FleetViewSchema, {
					fleet,
					members: records.map((record) =>
						create(FleetMemberViewSchema, {
							memberId: record.memberId,
							name: record.memberships[0]?.name ?? "",
							kind: record.kind,
							state: record.state,
							availability: lost.includes(record.memberId)
								? Availability.LOST
								: Availability.LIVE,
						}),
					),
				});
			},
		},
		fleetOf: (yardId) => (yardId === "yard-a" ? FLEET : undefined),
	};
	return members;
}

function harness(members: CampMembers | undefined) {
	const store = new MemoryEventStore();
	const time = clock();
	const inventory = createCampInventory({
		store,
		tenant: TENANT,
		now: time.now,
		topology: new FakeTopology([
			topology("eu-1"),
			topology("other-1", { yardId: "yard-b" }),
		]),
		rails: new FakeRails(),
		desired: new FakeDesired(),
		authorizer: new FakeAuthorizer(),
		telemetry: new RecordingTelemetry(),
		members,
	});
	const station = context(time.now, STATION);
	return {
		inventory,
		async contact(...campIds: string[]) {
			await inventory.tick(station);
			for (const id of campIds) await store.reconcileEvent(id);
			await inventory.tick(station);
		},
		tick: () => inventory.tick(station),
	};
}

function noPlace(status: CampStatusRecord | undefined) {
	return (status?.taints ?? []).filter(
		(taint) => taint.effect === TaintEffect.NO_PLACE,
	);
}

const ACTIVE_ID = `tgt_${"a".repeat(32)}`;

describe("Camp mapper: fleet member lifecycle (L19)", () => {
	it("names a Camp's member after the last segment of its id, as a fleet short name", () => {
		expect(campMemberName(camp("hobo-ci-runners/Box.1"))).toBe("box-1");
		expect(campMemberName(camp("eu-1"))).toBe("eu-1");
	});

	it("an ACTIVE backing member adds no taint", async () => {
		const h = harness(
			registry([member(ACTIVE_ID, "eu-1", MemberState.ACTIVE)]),
		);
		await h.contact("eu-1");
		expect(noPlace(await h.inventory.status(camp("eu-1")))).toEqual([]);
	});

	it.each([
		[MemberState.SUSPENDED, "member-suspended"],
		[MemberState.REVOKED, "member-revoked"],
	])("a %s member is an automatic NO_PLACE taint", async (state, reason) => {
		const h = harness(registry([member(ACTIVE_ID, "eu-1", state)]));
		await h.contact("eu-1");
		const taints = noPlace(await h.inventory.status(camp("eu-1")));
		expect(taints.map((taint) => [taint.key, taint.reason])).toEqual([
			[AUTO_TAINTS.memberInactive, reason],
		]);
		expect(taints[0]?.source).toBe(SignalSource.STATION);
	});

	it("a Camp of a mapped Yard with no member is NO_PLACE (member-missing)", async () => {
		const h = harness(registry([]));
		await h.contact("eu-1");
		const taints = noPlace(await h.inventory.status(camp("eu-1")));
		expect(taints.map((taint) => [taint.key, taint.reason])).toEqual([
			[AUTO_TAINTS.memberInactive, "member-missing"],
		]);
	});

	it("a Yard with no fleet, or no mapper at all, keeps today's behaviour", async () => {
		const mapped = harness(registry([]));
		await mapped.contact("other-1");
		expect(noPlace(await mapped.inventory.status(camp("other-1")))).toEqual([]);
		const unmapped = harness(undefined);
		await unmapped.contact("eu-1");
		expect(noPlace(await unmapped.inventory.status(camp("eu-1")))).toEqual([]);
	});

	it("the taint clears once the member is ACTIVE again", async () => {
		const records = [member(ACTIVE_ID, "eu-1", MemberState.SUSPENDED)];
		const h = harness(registry(records));
		await h.contact("eu-1");
		expect(noPlace(await h.inventory.status(camp("eu-1")))).toHaveLength(1);
		records[0] = member(ACTIVE_ID, "eu-1", MemberState.ACTIVE);
		await h.contact("eu-1");
		expect(noPlace(await h.inventory.status(camp("eu-1")))).toEqual([]);
	});

	it("an agentless TARGET's reachability still comes from the signal sources", async () => {
		// A TARGET has no device observing it: a LOST view entry is not evidence.
		const h = harness(
			registry([member(ACTIVE_ID, "eu-1", MemberState.ACTIVE)], [ACTIVE_ID]),
		);
		await h.contact("eu-1");
		const status = await h.inventory.status(camp("eu-1"));
		const reachable = status?.conditions.find(
			(entry) =>
				entry.type === CampConditionType.REACHABLE &&
				entry.source === SignalSource.STATION,
		);
		expect(reachable?.status).toBe(ConditionStatus.TRUE);
		expect(noPlace(status)).toEqual([]);
	});

	it("a reconciler DEVICE the fleet observes LOST makes its Camp unreachable", async () => {
		const id = `dev_${"b".repeat(32)}`;
		const h = harness(
			registry(
				[member(id, "eu-1", MemberState.ACTIVE, MemberKind.DEVICE)],
				[id],
			),
		);
		await h.contact("eu-1");
		const status = await h.inventory.status(camp("eu-1"));
		expect(noPlace(status).map((taint) => taint.key)).toEqual([
			AUTO_TAINTS.unreachable,
		]);
	});
});
