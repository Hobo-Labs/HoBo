// Arrangement helpers for the pipeline controller tests.
import { create, toJson } from "@bufbuild/protobuf";
import {
	type PipelineNodeRecord,
	PipelineNodeRecordSchema,
	type PipelineRecord,
	PipelineRecordSchema,
	PromotionRecordSchema,
	PromotionState,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import { createPipelineController } from "../../src/pipelines/index.js";
import type { ChangeWindows } from "../../src/ports.js";
import {
	FakeFanout,
	FakeFreightLedger,
	FakePlacement,
	FakePromotions,
	FakeTopology,
	ledgerPort,
} from "./doubles.js";
import {
	clock,
	context,
	MemoryEventStore,
	RecordingAuthorizer,
	RecordingTelemetry,
	T0,
	TENANT,
} from "./fakes.js";

export function node(name: string, fields: Partial<Omit<PipelineNodeRecord, "$typeName" | "name">> = {}): PipelineNodeRecord {
	return create(PipelineNodeRecordSchema, { name, ...fields });
}

export function pipeline(name: string, nodes: readonly PipelineNodeRecord[], fields: Partial<Omit<PipelineRecord, "$typeName" | "name" | "nodes">> = {}): PipelineRecord {
	return create(PipelineRecordSchema, { name, bindle: "acme/shop", nodes: [...nodes], ...fields });
}

export type HarnessOptions = Readonly<{
	windows?: ChangeWindows;
	placementContext?: boolean;
	start?: number;
}>;

export function harness(options: HarnessOptions = {}) {
	const c = clock(options.start ?? T0);
	const store = new MemoryEventStore(c.now);
	const ledger = new FakeFreightLedger();
	const promotions = new FakePromotions(store);
	const placement = new FakePlacement();
	const fanout = new FakeFanout();
	const topology = new FakeTopology();
	const authorizer = new RecordingAuthorizer();
	const telemetry = new RecordingTelemetry();
	for (const id of ["dev-1", "staging-1", "staging-2", "prod-1", "prod-2", "preview-1"]) topology.add(id);
	const build = () =>
		createPipelineController({
			store,
			tenant: TENANT,
			now: c.now,
			freight: ledgerPort(ledger),
			promotions,
			placement,
			fanout,
			topology,
			authorizer,
			telemetry,
			...(options.windows ? { windows: options.windows } : {}),
			...(options.placementContext === false
				? {}
				: {
						placementContext: async () => ({
							stationId: "station-1",
							subject: { classifications: [], residency: [] },
						}),
					}),
		});
	const controller = build();
	const ctx = context(c.now);
	return {
		c,
		store,
		ledger,
		promotions,
		placement,
		fanout,
		topology,
		authorizer,
		telemetry,
		controller,
		build,
		ctx,
		/** Define a Freight source the way WP2 does (a `source.Defined` fact). */
		async source(name: string) {
			await store.seed(CD_STREAMS.source(name), CD_EVENTS.SourceDefined, { name, bindle: "acme/shop" });
		},
		/** Record that a promotion converged (WP6's `env.Promoted`) at the current clock. */
		async promoted(freightId: string, campIds: readonly string[], pipelineName: string, nodeName: string) {
			const id = `p-${store.all.length}`;
			await store.seed(
				CD_STREAMS.promotion(id),
				CD_EVENTS.EnvPromoted,
				toJson(PromotionRecordSchema, create(PromotionRecordSchema, { promotionId: id, freightId, targetCampIds: [...campIds], pipeline: pipelineName, node: nodeName, state: PromotionState.PROMOTED })),
			);
		},
	};
}
