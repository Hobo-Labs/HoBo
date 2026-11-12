// data-models/placement.cue and the placement parse boundary must agree: what
// the engine records vets clean, and what the parsers refuse, CUE refuses.
import { create, type JsonValue, toJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	CampSetRecordSchema,
	PlacementCandidateRecordSchema,
	PlacementGroupRecordSchema,
	PlacementRecordSchema,
	ScoreSnapshotRecordSchema,
	ScoreWeightRecordSchema,
	SelectorRecordSchema,
	SpreadConstraintRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS, PLACEMENT_SCHEMA } from "../../src/events.js";
import { createCampInventory } from "../../src/inventory/index.js";
import {
	createPlacementEngine,
	parsePlacement,
	scoreStream,
} from "../../src/placement/index.js";
import { cue, vetter } from "../inventory/cue-support.js";
import {
	clock,
	context,
	FakeAuthorizer,
	FakeDesired,
	FakeRails,
	FakeTopology,
	MemoryEventStore,
	MINUTE,
	railDelivery,
	STATION,
	TENANT,
	topology,
} from "../inventory/fakes.js";

const vets = vetter("placement.cue");

const valid = () =>
	create(PlacementRecordSchema, {
		schemaVersion: PLACEMENT_SCHEMA,
		name: "web",
		campSets: ["fleet"],
		spread: [
			create(SpreadConstraintRecordSchema, {
				topologyKey: "provider",
				minGroups: 1,
				maxGroups: 2,
			}),
		],
		scores: [
			create(ScoreWeightRecordSchema, { score: "capacity", weight: 1.5 }),
		],
		groups: [
			create(PlacementGroupRecordSchema, {
				name: "pilot",
				selector: create(SelectorRecordSchema, { labels: { ring: "pilot" } }),
				maxSize: 1,
			}),
		],
		defaultGroupSize: 2,
		definedBy: "user:ops@acme",
	});

describe.skipIf(cue === undefined)(
	"placement.cue agrees with the parse boundary (skips with no cue binary: run scripts/bootstrap-dev.sh)",
	() => {
		it("vets the placement, score snapshot and decision the engine records", async () => {
			const store = new MemoryEventStore();
			const time = clock();
			const declared = [
				topology("a", { labels: { ring: "pilot" } }),
				topology("b", { provider: "gcp" }),
				topology("c"),
			];
			const rails = new FakeRails(railDelivery({ campSets: ["fleet"] }));
			const authorizer = new FakeAuthorizer();
			const inventory = createCampInventory({
				store,
				tenant: TENANT,
				now: time.now,
				topology: new FakeTopology(declared),
				rails,
				desired: new FakeDesired(),
				authorizer,
				telemetry: {
					spans: async () => undefined,
					metrics: async () => undefined,
				},
			});
			const engine = createPlacementEngine({
				store,
				tenant: TENANT,
				now: time.now,
				inventory,
				rails,
				authorizer,
				approvedProviders: async () => ["aws", "gcp"],
			});
			const ops = context(time.now);
			await inventory.defineSet(
				create(CampSetRecordSchema, {
					name: "fleet",
					campIds: ["a", "b", "c"],
				}),
				ops,
			);
			await inventory.tick(context(time.now, STATION));
			for (const entry of declared) await store.reconcileEvent(entry.campId);
			await inventory.tick(context(time.now, STATION));
			expect((await engine.define(valid(), ops)).ok).toBe(true);
			expect(
				(
					await engine.reportScores(
						create(ScoreSnapshotRecordSchema, {
							score: "capacity",
							byCamp: { a: 1, b: 2 },
							validUntil: new Date(time.now() + MINUTE).toISOString(),
						}),
						ops,
					)
				).ok,
			).toBe(true);
			const decided = await engine.decide(
				{
					placement: "web",
					pipeline: "shop",
					node: "prod",
					stationId: "station-eu",
					subject: { classifications: [], residency: [] },
				},
				ops,
			);
			expect(decided.ok).toBe(true);
			const events = store.events(CD_STREAMS.placement("web"));
			expect(
				vets(
					"#PlacementRecord",
					events.find((e) => e.type === CD_EVENTS.PlacementDefined)
						?.data as JsonValue,
				),
			).toBe(true);
			expect(
				vets(
					"#PlacementDecisionRecord",
					events.find((e) => e.type === CD_EVENTS.PlacementDecided)
						?.data as JsonValue,
				),
			).toBe(true);
			expect(
				vets(
					"#ScoreSnapshotRecord",
					store.events(scoreStream("capacity"))[0]?.data as JsonValue,
				),
			).toBe(true);
		});

		it("refuses what parsePlacement refuses", () => {
			const cases = [
				create(PlacementRecordSchema, { ...valid(), name: "score-web" }),
				create(PlacementRecordSchema, {
					...valid(),
					schemaVersion: "hobo.cd.placement/v0",
				}),
				create(PlacementRecordSchema, { ...valid(), campSets: [] }),
				create(PlacementRecordSchema, {
					...valid(),
					spread: [
						create(SpreadConstraintRecordSchema, { topologyKey: "rack" }),
					],
				}),
				create(PlacementRecordSchema, {
					...valid(),
					spread: [
						create(SpreadConstraintRecordSchema, {
							topologyKey: "yard",
							minGroups: 3,
							maxGroups: 2,
						}),
					],
				}),
				create(PlacementRecordSchema, {
					...valid(),
					defaultGroupSizePercent: 10,
				}),
				create(PlacementRecordSchema, {
					...valid(),
					groups: [
						create(PlacementGroupRecordSchema, {
							name: "g",
							maxSizePercent: 150,
						}),
					],
				}),
				create(PlacementRecordSchema, {
					...valid(),
					predicate: create(SelectorRecordSchema, { bindles: ["shop"] }),
				}),
			];
			for (const placement of cases) {
				expect(parsePlacement(placement).ok).toBe(false);
				expect(
					vets("#PlacementRecord", toJson(PlacementRecordSchema, placement)),
				).toBe(false);
			}
			expect(parsePlacement(valid()).ok).toBe(true);
			expect(
				vets("#PlacementRecord", toJson(PlacementRecordSchema, valid())),
			).toBe(true);
		});

		it("a selected candidate never carries an exclusion code", () => {
			const bad = create(PlacementCandidateRecordSchema, {
				campId: "a",
				selected: true,
				exclusionCodes: ["observe-only"],
			});
			expect(
				vets(
					"#PlacementCandidateRecord",
					toJson(PlacementCandidateRecordSchema, bad),
				),
			).toBe(false);
			const unknown = create(PlacementCandidateRecordSchema, {
				campId: "a",
				exclusionCodes: ["because"],
			});
			expect(
				vets(
					"#PlacementCandidateRecord",
					toJson(PlacementCandidateRecordSchema, unknown),
				),
			).toBe(false);
		});
	},
);
