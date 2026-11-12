// Golden v1 event bodies for placement.* (append-only upcaster corpus): a
// journal written by this release must fold identically in every later one.
// Changing a body shape needs an upcaster plus a new corpus entry, never an
// edit here.
import type { JsonObject } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { TaintEffect } from "../../src/_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import { createCampInventory } from "../../src/inventory/index.js";
import {
	createPlacementEngine,
	scoreStream,
} from "../../src/placement/index.js";
import {
	clock,
	FakeAuthorizer,
	FakeDesired,
	FakeRails,
	FakeTopology,
	MemoryEventStore,
	OPERATOR,
	STATION,
	T0,
	TENANT,
} from "../inventory/fakes.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

const PLACEMENT: JsonObject = {
	schemaVersion: "hobo.cd.placement/v1",
	name: "web",
	campSets: ["eu-prod"],
	predicate: { envTypes: ["prod"] },
	requiredClaims: ["platform=linux"],
	count: 2,
	spread: [{ topologyKey: "provider", minGroups: 2 }],
	scores: [{ score: "capacity", weight: 1.5 }],
	tolerations: [
		{
			key: "maintenance",
			effect: "TAINT_EFFECT_NO_RUN",
			tolerationMs: "300000",
		},
	],
	groups: [
		{ name: "pilot", selector: { labels: { ring: "pilot" } }, maxSize: 1 },
	],
	defaultGroupSizePercent: 10,
	definedBy: "user:ops@acme",
};

const SCORES: JsonObject = {
	score: "capacity",
	byCamp: { "eu-1": 2, "eu-2": 1.25 },
	validUntil: "2026-11-12T13:00:00.000Z",
	reportedBy: "service:scorer",
	reportedAt: "2026-11-12T11:00:00.000Z",
	digest: DIGEST_B,
};

const DECISION: JsonObject = {
	decisionId: "pd-0123456789abcdef0123456789abcdef",
	placement: "web",
	pipeline: "shop",
	node: "prod",
	inventoryDigest: DIGEST_A,
	scoreSnapshotDigests: [DIGEST_B],
	groups: [
		{ name: "pilot", index: 0, campIds: ["eu-1"] },
		{ name: "default-1", index: 1, campIds: ["eu-2"] },
	],
	candidates: [
		{ campId: "eu-1", selected: true, score: 3 },
		{ campId: "eu-2", selected: true, score: 1.875 },
		{
			campId: "us-1",
			exclusionCodes: ["residency-conflict:jurisdiction-not-allowed"],
		},
	],
	reasons: [
		{
			code: "set-not-bound",
			message: "m",
			remediation: "r",
			subject: "shadow",
		},
	],
	decidedAt: "2026-11-12T12:00:00.000Z",
};

describe("golden placement journal corpus (v1 bodies)", () => {
	it("folds placement.Defined, placement.ScoresReported and placement.Decided", async () => {
		const store = new MemoryEventStore();
		await store.append(
			CD_STREAMS.placement("web"),
			[
				{ type: CD_EVENTS.PlacementDefined, v: 1, data: PLACEMENT },
				{ type: CD_EVENTS.PlacementDecided, v: 1, data: DECISION },
			],
			{ expectedSeq: 0, actor: OPERATOR, tenant: TENANT },
		);
		await store.append(
			scoreStream("capacity"),
			[{ type: CD_EVENTS.PlacementScoresReported, v: 1, data: SCORES }],
			{ expectedSeq: 0, actor: STATION, tenant: TENANT },
		);
		const time = clock(T0);
		const rails = new FakeRails();
		const authorizer = new FakeAuthorizer();
		const inventory = createCampInventory({
			store,
			tenant: TENANT,
			now: time.now,
			topology: new FakeTopology([]),
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
		});
		const placement = await engine.get("web");
		expect(placement?.count).toBe(2);
		expect(placement?.tolerations[0]?.tolerationMs).toBe(300_000n);
		expect(placement?.tolerations[0]?.effect).toBe(TaintEffect.NO_RUN);
		expect(placement?.groups[0]?.selector?.labels).toEqual({ ring: "pilot" });
		const decision = await engine.decision(
			"pd-0123456789abcdef0123456789abcdef",
		);
		expect(decision?.groups.map((group) => group.campIds)).toEqual([
			["eu-1"],
			["eu-2"],
		]);
		expect(decision?.candidates[2]?.exclusionCodes).toEqual([
			"residency-conflict:jurisdiction-not-allowed",
		]);
		expect(decision?.scoreSnapshotDigests).toEqual([DIGEST_B]);
		// The recorded snapshot is re-read for later decisions as is.
		const reported = store.events(scoreStream("capacity"))[0]
			?.data as JsonObject;
		expect(reported.digest).toBe(DIGEST_B);
	});
});
