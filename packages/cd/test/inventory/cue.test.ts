// data-models/inventory.cue and the inventory parse boundary must agree: what
// the inventory records vets clean, and what the parsers refuse, CUE refuses.
import { create, toJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	CampClaimRecordSchema,
	CampConditionRecordSchema,
	CampConditionType,
	CampSetRecordSchema,
	CampStatusRecordSchema,
	ConditionStatus,
	SelectorRecordSchema,
	SignalSource,
	TaintEffect,
	TaintRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import {
	createCampInventory,
	parseCampSet,
	parseTaint,
} from "../../src/inventory/index.js";
import { jsonOf } from "../../src/inventory/json.js";
import { cue, vetter } from "./cue-support.js";
import {
	AGENT,
	camp,
	clock,
	context,
	FakeAuthorizer,
	FakeDesired,
	FakeRails,
	FakeTopology,
	MemoryEventStore,
	STATION,
	TENANT,
	topology,
} from "./fakes.js";

const vets = vetter("inventory.cue");

describe.skipIf(cue === undefined)(
	"inventory.cue agrees with the parse boundary (skips with no cue binary: run scripts/bootstrap-dev.sh)",
	() => {
		it("vets every status and set the inventory records", async () => {
			const store = new MemoryEventStore();
			const time = clock();
			const inventory = createCampInventory({
				store,
				tenant: TENANT,
				now: time.now,
				topology: new FakeTopology([
					topology("us-1", { regions: ["us-east-1"] }),
				]),
				rails: new FakeRails(),
				desired: new FakeDesired(),
				authorizer: new FakeAuthorizer(),
				telemetry: {
					spans: async () => undefined,
					metrics: async () => undefined,
				},
			});
			const ops = context(time.now);
			await inventory.tick(context(time.now, STATION));
			await inventory.observe(
				{
					campId: camp("us-1"),
					source: SignalSource.RECONCILER,
					conditions: [
						create(CampConditionRecordSchema, {
							type: CampConditionType.READY,
							status: ConditionStatus.TRUE,
						}),
					],
					claims: [
						create(CampClaimRecordSchema, {
							name: "region",
							value: "eu-west-1",
						}),
					],
				},
				context(time.now, AGENT),
			);
			await inventory.taint(
				{
					campId: camp("us-1"),
					taint: create(TaintRecordSchema, {
						key: "maintenance",
						effect: TaintEffect.NO_RUN,
						reason: "rack",
					}),
				},
				ops,
			);
			await inventory.defineSet(
				create(CampSetRecordSchema, {
					name: "us",
					selector: create(SelectorRecordSchema, { jurisdictions: ["us"] }),
				}),
				ops,
			);
			const recorded = store.events(CD_STREAMS.campInventory("us-1"));
			const statuses = recorded.filter(
				(event) => event.type === CD_EVENTS.CampStatusChanged,
			);
			expect(statuses.length).toBeGreaterThan(1);
			for (const event of statuses)
				expect(vets("#CampStatusRecord", jsonOf(event.data) ?? null)).toBe(
					true,
				);
			for (const event of recorded.filter(
				(entry) =>
					entry.type === CD_EVENTS.CampTainted ||
					entry.type === CD_EVENTS.CampUntainted,
			)) {
				expect(vets("#TaintRecord", jsonOf(event.data) ?? null)).toBe(true);
			}
			for (const event of store.events(CD_STREAMS.campSet("us")))
				expect(vets("#CampSetRecord", jsonOf(event.data) ?? null)).toBe(true);
		});

		it("refuses what the parsers refuse", () => {
			const bindleSet = create(CampSetRecordSchema, {
				name: "b",
				selector: create(SelectorRecordSchema, { bindles: ["shop"] }),
				definedBy: "user:ops",
			});
			expect(parseCampSet(bindleSet).ok).toBe(false);
			expect(
				vets("#CampSetRecord", toJson(CampSetRecordSchema, bindleSet)),
			).toBe(false);
			const badName = create(CampSetRecordSchema, {
				name: "Not A Slug",
				campIds: ["a"],
				definedBy: "user:ops",
			});
			expect(parseCampSet(badName).ok).toBe(false);
			expect(vets("#CampSetRecord", toJson(CampSetRecordSchema, badName))).toBe(
				false,
			);
			const badKey = create(TaintRecordSchema, {
				key: "-bad",
				effect: TaintEffect.NO_PLACE,
				source: SignalSource.OPERATOR,
				addedBy: "user:ops",
				addedAt: "2026-11-12T12:00:00.000Z",
			});
			expect(parseTaint(badKey).ok).toBe(false);
			expect(vets("#TaintRecord", toJson(TaintRecordSchema, badKey))).toBe(
				false,
			);
		});

		it("refuses an agent-sourced NO_RUN taint and an unspecified condition", () => {
			const selfNoRun = create(TaintRecordSchema, {
				key: "x",
				effect: TaintEffect.NO_RUN,
				source: SignalSource.RECONCILER,
				addedBy: "agent:a",
				addedAt: "2026-11-12T12:00:00.000Z",
			});
			expect(vets("#TaintRecord", toJson(TaintRecordSchema, selfNoRun))).toBe(
				false,
			);
			const status = create(CampStatusRecordSchema, {
				campId: "a",
				conditions: [
					create(CampConditionRecordSchema, {
						type: CampConditionType.READY,
						source: SignalSource.STATION,
					}),
				],
			});
			expect(
				vets("#CampStatusRecord", toJson(CampStatusRecordSchema, status)),
			).toBe(false);
		});
	},
);
