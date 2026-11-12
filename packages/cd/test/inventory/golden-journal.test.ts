// Golden v1 event bodies for camp.* and campset.* (append-only upcaster
// corpus): a journal written by this release must fold identically in every
// later one. Changing a body shape needs an upcaster plus a new corpus entry,
// never an edit here.
import type { JsonObject } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	CampConditionType,
	CampManagement,
	ConditionStatus,
	SignalSource,
	TaintEffect,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import { createCampInventory } from "../../src/inventory/index.js";
import {
	camp,
	clock,
	context,
	FakeAuthorizer,
	FakeDesired,
	FakeRails,
	FakeTopology,
	MemoryEventStore,
	OPERATOR,
	SECOND,
	STATION,
	T0,
	TENANT,
	topology,
} from "./fakes.js";

const TAINT: JsonObject = {
	key: "maintenance",
	value: "rack-7",
	effect: "TAINT_EFFECT_NO_RUN",
	source: "SIGNAL_SOURCE_OPERATOR",
	reason: "planned",
	addedBy: "user:ops@acme",
	addedAt: "2026-11-12T11:59:00.000Z",
};

const STATUS: JsonObject = {
	campId: "eu-1",
	management: "CAMP_MANAGEMENT_OBSERVE_ONLY",
	conditions: [
		{
			type: "CAMP_CONDITION_TYPE_READY",
			status: "CONDITION_STATUS_TRUE",
			source: "SIGNAL_SOURCE_HEALTH_SOURCE",
			reason: "probe",
			since: "2026-11-12T11:58:00.000Z",
		},
		{
			type: "CAMP_CONDITION_TYPE_REACHABLE",
			status: "CONDITION_STATUS_TRUE",
			source: "SIGNAL_SOURCE_STATION",
			reason: "contact",
			since: "2026-11-12T11:58:00.000Z",
		},
		{
			type: "CAMP_CONDITION_TYPE_LEASED",
			status: "CONDITION_STATUS_TRUE",
			source: "SIGNAL_SOURCE_STATION",
			reason: "lease-active",
			since: "2026-11-12T11:58:00.000Z",
		},
		{
			type: "CAMP_CONDITION_TYPE_CLAIMS_CONSISTENT",
			status: "CONDITION_STATUS_TRUE",
			source: "SIGNAL_SOURCE_STATION",
			reason: "consistent",
			since: "2026-11-12T11:58:00.000Z",
		},
	],
	claims: [
		{
			name: "platform",
			value: "linux",
			reportedBy: "reconciler:rec-1",
			observedAt: "2026-11-12T11:58:00.000Z",
		},
	],
	taints: [TAINT],
	updatedAt: "2026-11-12T12:00:00.000Z",
};

const CORPUS: readonly Readonly<{
	type: string;
	v: 1;
	data: JsonObject;
	meta?: JsonObject;
}>[] = [
	{
		type: CD_EVENTS.CampManagementChanged,
		v: 1,
		data: { campId: "eu-1", management: "CAMP_MANAGEMENT_OBSERVE_ONLY" },
	},
	{ type: CD_EVENTS.CampTainted, v: 1, data: TAINT },
	{
		type: CD_EVENTS.CampStatusChanged,
		v: 1,
		data: STATUS,
		meta: {
			contact: {
				lastContactAt: "2026-11-12T12:00:00.000Z",
				lastLeaseAt: "2026-11-12T12:00:00.000Z",
			},
		},
	},
	{
		type: CD_EVENTS.CampUntainted,
		v: 1,
		data: { ...TAINT, key: "old", effect: "TAINT_EFFECT_NO_PLACE" },
	},
];

const SET: JsonObject = {
	name: "eu-prod",
	selector: { envTypes: ["prod"], jurisdictions: ["eu"] },
	campIds: ["eu-9"],
	definedBy: "user:ops@acme",
};

describe("golden inventory journal corpus (v1 bodies)", () => {
	it("folds camp.* bodies into the recorded status and keeps recorded contact", async () => {
		const store = new MemoryEventStore();
		await store.append(
			CD_STREAMS.campInventory("eu-1"),
			CORPUS.map((entry) => ({
				type: entry.type,
				v: entry.v,
				data: entry.data,
				meta: entry.meta ?? {},
			})),
			{ expectedSeq: 0, actor: OPERATOR, tenant: TENANT },
		);
		await store.append(
			CD_STREAMS.campSet("eu-prod"),
			[{ type: CD_EVENTS.CampSetDefined, v: 1, data: SET }],
			{ expectedSeq: 0, actor: OPERATOR, tenant: TENANT },
		);
		const time = clock(T0 + 31 * SECOND);
		const inventory = createCampInventory({
			store,
			tenant: TENANT,
			now: time.now,
			topology: new FakeTopology([
				topology("eu-1", { labels: {} }),
				topology("eu-9", { envType: "dev", regions: ["us-east-1"] }),
			]),
			rails: new FakeRails(),
			desired: new FakeDesired(),
			authorizer: new FakeAuthorizer(),
			telemetry: {
				spans: async () => undefined,
				metrics: async () => undefined,
			},
		});
		const status = await inventory.status(camp("eu-1"));
		expect(status?.management).toBe(CampManagement.OBSERVE_ONLY);
		expect(status?.taints.map((taint) => [taint.key, taint.effect])).toEqual([
			["maintenance", TaintEffect.NO_RUN],
		]);
		expect(status?.claims.map((claim) => claim.reportedBy)).toEqual([
			"reconciler:rec-1",
		]);
		expect(
			status?.conditions.find((c) => c.source === SignalSource.HEALTH_SOURCE)
				?.type,
		).toBe(CampConditionType.READY);
		await inventory.tick(context(time.now, STATION));
		const after = await inventory.status(camp("eu-1"));
		expect(
			after?.conditions.find(
				(c) =>
					c.type === CampConditionType.REACHABLE &&
					c.source === SignalSource.STATION,
			)?.status,
		).toBe(ConditionStatus.TRUE);
		expect(
			after?.conditions.find(
				(c) =>
					c.type === CampConditionType.LEASED &&
					c.source === SignalSource.STATION,
			)?.status,
		).toBe(ConditionStatus.FALSE);
		expect((await inventory.sets()).map((set) => set.name)).toEqual([
			"eu-prod",
		]);
		expect(
			(await inventory.list({ campSets: ["eu-prod"] })).map(
				(view) => view.topology.campId,
			),
		).toEqual(["eu-1", "eu-9"]);
	});
});
