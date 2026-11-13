import { clone, create, toBinary } from "@bufbuild/protobuf";
import {
	MEMBER_RECORD_CONTEXT,
	type MemberRecord,
	MemberRecordSchema,
	MemberState,
	parseFleetId,
	SignedEnvelopeSchema,
	WitnessedEnvelopeSchema,
} from "@hobo/fleet";
import { signEnvelope } from "@hobo/fleet/keys";
import { describe, expect, it } from "vitest";
import { createRegistryView, devicePin } from "../src/bus/registry-view.js";
import { createTenant, TENANT } from "./support/fixture.js";

/** A copy of `record` with `change` applied. */
function changed(
	record: MemberRecord | undefined,
	change: (next: MemberRecord) => void,
): MemberRecord {
	if (record === undefined) throw new Error("no record");
	const next = clone(MemberRecordSchema, record);
	change(next);
	return next;
}

describe("the device's registry view", () => {
	it("verifies records against the pinned trust and refuses what the bus forges", async () => {
		const tenant = await createTenant();
		const keys = await tenant.device();
		const wire = tenant.nats.connect();
		const log: string[] = [];
		const view = createRegistryView({
			wire,
			pin: devicePin(tenant.trust, (event) => log.push(event)),
			now: tenant.now,
		});
		const record = await view.member(keys.memberId);
		expect(record?.state).toBe(MemberState.ACTIVE);
		expect(view.trust().tenant).toBe(TENANT);
		expect((await view.members()).map((m) => m.memberId)).toEqual([
			keys.memberId,
		]);
		expect(
			await view.membersOf(parseFleetId(record?.memberships[0]?.fleet ?? "")),
		).toHaveLength(1);

		// A record signed by a key the trust record does not list.
		const other = await tenant.device();
		const forged = await signEnvelope(
			keys.sign,
			MEMBER_RECORD_CONTEXT,
			toBinary(
				MemberRecordSchema,
				changed(record, (next) => {
					next.memberId = other.memberId;
					next.recordSequence = 9;
				}),
			),
		);
		await wire.kvPut(
			"fleet-registry",
			`member.${other.memberId}`,
			toBinary(SignedEnvelopeSchema, forged),
		);
		expect(await view.member(other.memberId)).toBeUndefined();

		// A genuine record stored under another member's key.
		const genuine = await wire.kvGet(
			"fleet-registry",
			`member.${keys.memberId}`,
		);
		if (genuine === undefined) throw new Error("no record");
		await wire.kvPut("fleet-registry", `member.${other.memberId}`, genuine);
		expect(await view.member(other.memberId)).toBeUndefined();
	});

	it("refuses a record once past its not_after, and a rollback to a lower sequence", async () => {
		const tenant = await createTenant();
		const keys = await tenant.device();
		const wire = tenant.nats.connect();
		const view = createRegistryView({
			wire,
			pin: devicePin(tenant.trust, () => undefined),
			now: tenant.now,
		});
		const first = await view.member(keys.memberId);
		expect(first?.recordSequence).toBe(1);
		const newer = await signEnvelope(
			tenant.authority,
			MEMBER_RECORD_CONTEXT,
			toBinary(
				MemberRecordSchema,
				changed(first, (next) => {
					next.recordSequence = 2;
				}),
			),
		);
		const older = await wire.kvGet("fleet-registry", `member.${keys.memberId}`);
		await tenant.bus.publisher.putMember(newer, keys.memberId);
		expect((await view.member(keys.memberId))?.recordSequence).toBe(2);
		if (older === undefined) throw new Error("no record");
		await wire.kvPut("fleet-registry", `member.${keys.memberId}`, older);
		expect(await view.member(keys.memberId)).toBeUndefined();

		tenant.setNow(tenant.now() + 31 * 60_000);
		await tenant.bus.publisher.putMember(newer, keys.memberId);
		expect(await view.member(keys.memberId)).toBeUndefined();
	});

	it("serves the pinned trust envelope and refuses an unwitnessed replacement", async () => {
		const tenant = await createTenant();
		const wire = tenant.nats.connect();
		const view = createRegistryView({
			wire,
			pin: devicePin(tenant.trust, () => undefined),
			now: tenant.now,
		});
		await view.caughtUp();
		expect(view.trustEnvelope()).toBe(tenant.trust);
		const unwitnessed = create(WitnessedEnvelopeSchema, {
			authority: tenant.trust.authority,
		});
		expect(() => devicePin(unwitnessed, () => undefined)).toThrow();
	});
});
