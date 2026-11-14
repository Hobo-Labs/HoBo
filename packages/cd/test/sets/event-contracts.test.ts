import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import {
	createCorpusBaseline,
	runCanDeployUpcasterGate,
	validateEventBody,
} from "@hobo/events";
import { describe, expect, it } from "vitest";
import { DeltaRecordSchema, SetOrigin } from "../../src/_generated/cd_pb.js";
import { CD_EVENTS } from "../../src/events.js";
import {
	createDesiredState,
	diffResolvedSets,
	SET_EVENT_CONTRACTS,
	setsCorpusBaseline,
	toCorpusBody,
} from "../../src/sets/index.js";
import {
	createFakeArtifactStore,
	createFakeEventStore,
	ctxAt,
	deltaId,
	reasonOf,
	resolvedFor,
	SHOP_V1,
	SHOP_V2,
	T0,
} from "./fakes.js";

const pinned = JSON.parse(
	readFileSync(
		new URL("./fixtures/sets-corpus-baseline.json", import.meta.url),
		"utf8",
	),
);

const OWNED = [
	CD_EVENTS.SetCreated,
	CD_EVENTS.DeltaOpened,
	CD_EVENTS.DeltaUpdated,
	CD_EVENTS.DeltaApplied,
	CD_EVENTS.DeltaRejected,
];

describe("upcaster corpus for set.Created and delta.*", () => {
	it("has one evolution contract per owned event type", () => {
		expect(SET_EVENT_CONTRACTS.map((c) => c.type).sort()).toEqual(
			[...OWNED].sort(),
		);
	});

	it.each(
		SET_EVENT_CONTRACTS.map((c) => [c.type, c] as const),
	)("%s replays clean through the can-deploy gate", (_type, contract) => {
		const baselineCorpus = {
			...pinned,
			entries: pinned.entries.filter((entry: { key: string }) =>
				entry.key.startsWith(`${contract.type}@`),
			),
		};
		const report = runCanDeployUpcasterGate(contract, { baselineCorpus });
		expect(report.errors).toEqual([]);
		expect(report.ok).toBe(true);
	});

	it("the pinned baseline file equals today's corpus (append-only)", () => {
		expect(setsCorpusBaseline()).toEqual(pinned);
		expect(
			createCorpusBaseline(SET_EVENT_CONTRACTS.flatMap((c) => c.goldenCorpus))
				.entries.length,
		).toBeGreaterThanOrEqual(5);
	});

	it("every body the ledger appends validates against the current schema of its type", async () => {
		const store = createFakeEventStore();
		const desired = createDesiredState({
			store,
			artifacts: createFakeArtifactStore(),
			tenant: "acme",
			now: () => T0,
		});
		const v1 = resolvedFor("prod-aws", SHOP_V1);
		const v2 = resolvedFor("prod-aws", SHOP_V2);
		const freightId = `sha256:${"1".repeat(64)}`;
		await desired.open(
			create(DeltaRecordSchema, {
				deltaId: "d1",
				campId: "prod-aws",
				intent: "up",
				freightId,
				changes: diffResolvedSets(undefined, v1),
			}),
			ctxAt(T0),
		);
		await desired.update(
			create(DeltaRecordSchema, {
				deltaId: "d1",
				campId: "prod-aws",
				intent: "up",
				freightId,
				changes: diffResolvedSets(undefined, v1),
			}),
			ctxAt(T0),
		);
		const set = await desired.apply(
			{
				deltaId: deltaId("d1"),
				gateDecisionId: "g1",
				resolved: v1,
				origin: SetOrigin.UP,
			},
			ctxAt(T0),
		);
		if (!set.ok) throw new Error("apply refused");
		await desired.open(
			create(DeltaRecordSchema, {
				deltaId: "d2",
				campId: "prod-aws",
				intent: "promote",
				baseSetId: set.value.setId,
				changes: diffResolvedSets(v1, v2),
			}),
			ctxAt(T0),
		);
		await desired.reject(
			deltaId("d2"),
			[reasonOf("window-closed", "m", "r", "s")],
			ctxAt(T0),
		);
		const seen = new Set<string>();
		for (const { event } of store.log) {
			const contract = SET_EVENT_CONTRACTS.find((c) => c.type === event.type);
			if (!contract) continue;
			const schema = contract.schemas.find(
				(s) => s.version === contract.currentVersion,
			);
			if (!schema) throw new Error("no current schema");
			const validation = validateEventBody(
				schema,
				toCorpusBody(event.type, event.data),
			);
			expect(validation.errors, event.type).toEqual([]);
			seen.add(event.type);
		}
		expect([...seen].sort()).toEqual([...OWNED].sort());
	});
});
