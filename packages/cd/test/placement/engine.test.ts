// WP22 PlacementEngine over a real CampInventory: governed definitions and
// score reports, recorded and replayable decisions, and the §10 rows owned by
// WP22 end to end.
import { create, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	CampClaimRecordSchema,
	CampSetRecordSchema,
	PlacementDecisionRecordSchema,
	PlacementRecordSchema,
	ScoreSnapshotRecordSchema,
	ScoreWeightRecordSchema,
	SelectorRecordSchema,
	SignalSource,
	SpreadConstraintRecordSchema,
} from "../../src/_generated/cd_pb.js";
import {
	CD_DEFAULTS,
	CD_EVENTS,
	CD_STREAMS,
	PLACEMENT_SCHEMA,
	PLACEMENT_UNSATISFIABLE,
} from "../../src/events.js";
import { createCampInventory } from "../../src/inventory/index.js";
import {
	createPlacementEngine,
	scoreStream,
} from "../../src/placement/index.js";
import type { PlacementSubject } from "../../src/ports.js";
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
	MINUTE,
	RecordingTelemetry,
	railDelivery,
	STATION,
	TENANT,
	topology,
} from "../inventory/fakes.js";

const EU_PII: PlacementSubject = {
	classifications: ["pii"],
	residency: [{ classifications: [], allowedJurisdictions: ["eu"] }],
};

async function harness(
	declared = [
		topology("eu-1"),
		topology("eu-2", { provider: "gcp", regions: ["europe-west1"] }),
		topology("us-1", { regions: ["us-east-1"] }),
	],
) {
	const store = new MemoryEventStore();
	const time = clock();
	const topo = new FakeTopology(declared);
	const rails = new FakeRails(railDelivery({ campSets: ["fleet"] }));
	const authorizer = new FakeAuthorizer();
	const telemetry = new RecordingTelemetry();
	const inventory = createCampInventory({
		store,
		tenant: TENANT,
		now: time.now,
		topology: topo,
		rails,
		desired: new FakeDesired(),
		authorizer,
		telemetry,
	});
	const make = () =>
		createPlacementEngine({
			store,
			tenant: TENANT,
			now: time.now,
			inventory,
			rails,
			authorizer,
			telemetry,
			approvedProviders: async () => ["aws", "gcp"],
		});
	const engine = make();
	const ops = context(time.now);
	await inventory.defineSet(
		create(CampSetRecordSchema, {
			name: "fleet",
			selector: create(SelectorRecordSchema, { envTypes: ["prod"] }),
		}),
		ops,
	);
	await inventory.tick(context(time.now, STATION));
	for (const entry of declared) await store.reconcileEvent(entry.campId);
	await inventory.tick(context(time.now, STATION));
	return {
		store,
		time,
		topo,
		rails,
		authorizer,
		telemetry,
		inventory,
		engine,
		make,
		ops,
	};
}

const basic = (
	overrides: Parameters<typeof create<typeof PlacementRecordSchema>>[1] = {},
) =>
	create(PlacementRecordSchema, {
		schemaVersion: PLACEMENT_SCHEMA,
		name: "web",
		campSets: ["fleet"],
		...overrides,
	});

const decideInput = {
	placement: "web",
	pipeline: "shop",
	node: "prod",
	stationId: "station-eu",
	subject: EU_PII,
};

describe("PlacementEngine.define and reportScores (D15, D20)", () => {
	it("define validates spread keys, group selectors and sizes with remediation", async () => {
		const h = await harness();
		const result = await h.engine.define(
			basic({
				spread: [
					create(SpreadConstraintRecordSchema, {
						topologyKey: "rack",
						minGroups: 1,
					}),
					create(SpreadConstraintRecordSchema, {
						topologyKey: "provider",
						minGroups: 3,
						maxGroups: 2,
					}),
				],
				groups: [
					{
						$typeName: "hobo.cd.v1.PlacementGroupRecord",
						name: "pilot",
						selector: create(SelectorRecordSchema, { bindles: ["shop"] }),
						maxSize: 0,
						maxSizePercent: 150,
					},
				],
				defaultGroupSize: 3,
				defaultGroupSizePercent: 10,
			}),
			h.ops,
		);
		expect(result.ok).toBe(false);
		const subjects = result.ok ? [] : result.reasons.map((r) => r.subject);
		expect(subjects).toEqual(
			expect.arrayContaining([
				"spread",
				"groups",
				"groups.pilot.selector.bindles",
				"defaultGroupSize",
			]),
		);
		expect(
			result.ok ? [] : result.reasons.every((r) => r.remediation !== ""),
		).toBe(true);
		expect(
			h.authorizer.calls.some((call) => call.action === "placement.define"),
		).toBe(false);
	});

	it("define is governed and idempotent", async () => {
		const h = await harness();
		const agent = await h.engine.define(basic(), context(h.time.now, AGENT));
		expect(agent.ok ? "" : agent.reasons[0]?.code).toBe("proposal-only");
		const first = await h.engine.define(basic(), h.ops);
		expect(first.ok ? first.value.definedBy : "").toBe("user:ops@acme");
		await h.engine.define(basic(), h.ops);
		expect(
			h.store
				.events(CD_STREAMS.placement("web"))
				.filter((e) => e.type === CD_EVENTS.PlacementDefined),
		).toHaveLength(1);
		expect(await h.engine.get("web")).toEqual(
			first.ok ? first.value : undefined,
		);
	});

	it("reportScores is authorized, stamped and digested; expired or over-long snapshots are refused", async () => {
		const h = await harness();
		const valid = create(ScoreSnapshotRecordSchema, {
			score: "capacity",
			byCamp: { "eu-1": 3 },
			validUntil: new Date(h.time.now() + MINUTE).toISOString(),
		});
		const stored = await h.engine.reportScores(
			valid,
			context(h.time.now, STATION),
		);
		expect(stored.ok ? stored.value.reportedBy : "").toBe("service:station-eu");
		expect(stored.ok ? stored.value.digest : "").toMatch(
			/^sha256:[0-9a-f]{64}$/u,
		);
		expect(h.authorizer.calls.at(-1)?.action).toBe("placement.scores");
		expect(h.store.events(scoreStream("capacity"))).toHaveLength(1);
		const expired = await h.engine.reportScores(
			create(ScoreSnapshotRecordSchema, {
				...valid,
				validUntil: new Date(h.time.now() - 1).toISOString(),
			}),
			h.ops,
		);
		expect(expired.ok ? "" : expired.reasons[0]?.code).toBe("score-expired");
		const tooLong = await h.engine.reportScores(
			create(ScoreSnapshotRecordSchema, {
				...valid,
				validUntil: new Date(
					h.time.now() + CD_DEFAULTS.scoreMaxValidityMs + 1,
				).toISOString(),
			}),
			h.ops,
		);
		expect(tooLong.ok ? "" : tooLong.reasons[0]?.code).toBe("score-invalid");
		h.authorizer.denied.add("placement.scores");
		const denied = await h.engine.reportScores(valid, h.ops);
		expect(denied.ok ? "" : denied.reasons[0]?.code).toBe("policy-denied");
	});
});

describe("PlacementEngine.decide (D20, I18, I19)", () => {
	it("records placement.Decided with the inventory and score digests; a retry is one event", async () => {
		const h = await harness();
		await h.engine.define(
			basic({
				scores: [
					create(ScoreWeightRecordSchema, { score: "capacity", weight: 1 }),
				],
			}),
			h.ops,
		);
		const reported = await h.engine.reportScores(
			create(ScoreSnapshotRecordSchema, {
				score: "capacity",
				byCamp: { "eu-2": 9 },
				validUntil: new Date(h.time.now() + MINUTE).toISOString(),
			}),
			h.ops,
		);
		const first = await h.engine.decide(decideInput, h.ops);
		expect(first.ok).toBe(true);
		const decision = first.ok ? first.value : undefined;
		expect(
			decision?.candidates.filter((c) => c.selected).map((c) => c.campId),
		).toEqual(["eu-2", "eu-1"]);
		expect(
			decision?.candidates.find((c) => c.campId === "us-1")?.exclusionCodes,
		).toEqual(["residency-conflict:jurisdiction-not-allowed"]);
		expect(decision?.scoreSnapshotDigests).toEqual([
			reported.ok ? reported.value.digest : "",
		]);
		expect(decision?.inventoryDigest).toBe(
			(await h.inventory.snapshot(["fleet"])).digest,
		);
		await h.engine.decide(decideInput, h.ops);
		expect(
			h.store
				.events(CD_STREAMS.placement("web"))
				.filter((e) => e.type === CD_EVENTS.PlacementDecided),
		).toHaveLength(1);
		expect(h.telemetry.count("hobo.cd.placement.decisions")).toBe(2);
		const replayed = await h.make().decision(decision?.decisionId ?? "");
		expect(
			replayed && decision
				? toBinary(PlacementDecisionRecordSchema, replayed)
				: undefined,
		).toEqual(
			decision ? toBinary(PlacementDecisionRecordSchema, decision) : undefined,
		);
	});

	it("inventory listed in a different order yields a byte-identical decision", async () => {
		const declared = [
			topology("eu-1"),
			topology("eu-2", { provider: "gcp", regions: ["europe-west1"] }),
			topology("eu-3", { regions: ["eu-central-1"] }),
		];
		const a = await harness(declared);
		const b = await harness([...declared].reverse());
		await a.engine.define(basic(), a.ops);
		await b.engine.define(basic(), b.ops);
		const left = await a.engine.decide(decideInput, a.ops);
		const right = await b.engine.decide(decideInput, b.ops);
		expect(left.ok && right.ok).toBe(true);
		expect(
			left.ok ? toBinary(PlacementDecisionRecordSchema, left.value) : 1,
		).toEqual(
			right.ok ? toBinary(PlacementDecisionRecordSchema, right.value) : 2,
		);
	});

	it("an agent claiming a region it is not declared in is NO_PLACE and never satisfies residency", async () => {
		const h = await harness();
		await h.inventory.observe(
			{
				campId: camp("us-1"),
				source: SignalSource.RECONCILER,
				conditions: [],
				claims: [
					create(CampClaimRecordSchema, { name: "region", value: "eu-west-1" }),
				],
			},
			context(h.time.now, AGENT),
		);
		await h.engine.define(basic(), h.ops);
		const result = await h.engine.decide(decideInput, h.ops);
		const liar = result.ok
			? result.value.candidates.find((c) => c.campId === "us-1")
			: undefined;
		expect(liar?.selected).toBe(false);
		expect(liar?.exclusionCodes).toEqual([
			"taint-not-tolerated",
			"residency-conflict:jurisdiction-not-allowed",
		]);
	});

	it("an unbound set is invisible to decide", async () => {
		const h = await harness();
		await h.inventory.defineSet(
			create(CampSetRecordSchema, { name: "secret", campIds: ["us-1"] }),
			h.ops,
		);
		await h.engine.define(basic({ campSets: ["secret"] }), h.ops);
		const result = await h.engine.decide(
			{ ...decideInput, subject: { classifications: [], residency: [] } },
			h.ops,
		);
		expect(result.ok).toBe(false);
		expect(result.ok ? [] : result.reasons.map((r) => r.code)).toEqual([
			"set-not-bound",
			PLACEMENT_UNSATISFIABLE,
		]);
	});

	it("spread provider min 3 with two providers is placement-unsatisfiable and records nothing", async () => {
		const h = await harness();
		await h.engine.define(
			basic({
				spread: [
					create(SpreadConstraintRecordSchema, {
						topologyKey: "provider",
						minGroups: 3,
					}),
				],
			}),
			h.ops,
		);
		const result = await h.engine.decide(
			{ ...decideInput, subject: { classifications: [], residency: [] } },
			h.ops,
		);
		expect(
			result.ok
				? undefined
				: result.reasons.find((r) => r.code === PLACEMENT_UNSATISFIABLE)
						?.subject,
		).toBe("provider");
		expect(
			h.store
				.events(CD_STREAMS.placement("web"))
				.some((e) => e.type === CD_EVENTS.PlacementDecided),
		).toBe(false);
	});

	it("an unknown placement is refused", async () => {
		const h = await harness();
		const result = await h.engine.decide(
			{ ...decideInput, placement: "nope" },
			h.ops,
		);
		expect(result.ok ? "" : result.reasons[0]?.code).toBe(
			"placement-not-found",
		);
	});

	it("exclude and count serve failover re-decisions (one replacement, never the source)", async () => {
		const h = await harness();
		await h.engine.define(basic(), h.ops);
		const result = await h.engine.decide(
			{ ...decideInput, exclude: [camp("eu-1")], count: 1 },
			h.ops,
		);
		expect(
			result.ok
				? result.value.candidates.filter((c) => c.selected).map((c) => c.campId)
				: [],
		).toEqual(["eu-2"]);
	});
});
