import { fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	Availability,
	CampSetRecordSchema,
	CD_DEFAULTS,
	DepartureAction,
	FanoutStrategy,
	PipelineRecordSchema,
	PlacementRecordSchema,
	PurgeMode,
	RailDeliveryRecordSchema,
} from "@hobo/cd";
import { runDeliveryRecordsConformance } from "@hobo/conformance";
import { describe, expect, it } from "vitest";
import { delivery, fanout, pipeline, placement, railDelivery, stores } from "../src/hobo.delivery.js";

const storesNode = () => pipeline.nodes.find((node) => node.name === "stores");

describe("cd-edge-fleet delivery module", () => {
	it("passes the delivery-records conformance suite", async () => {
		const report = await runDeliveryRecordsConformance("cd-edge-fleet", delivery);
		expect(report.failures).toEqual([]);
	});
	it("round-trips every record through the protobuf wire contract", () => {
		expect(fromBinary(PipelineRecordSchema, toBinary(PipelineRecordSchema, pipeline))).toEqual(pipeline);
		expect(fromBinary(PlacementRecordSchema, toBinary(PlacementRecordSchema, placement))).toEqual(placement);
		expect(fromBinary(CampSetRecordSchema, toBinary(CampSetRecordSchema, stores))).toEqual(stores);
		expect(fromBinary(RailDeliveryRecordSchema, toBinary(RailDeliveryRecordSchema, railDelivery))).toEqual(railDelivery);
	});
	it("D21: the fleet node names a placement and a fan-out, never a Camp list", () => {
		expect(storesNode()?.campIds).toEqual([]);
		expect(storesNode()?.placement).toBe(placement.name);
		expect(storesNode()?.fanout?.strategy).toBe(FanoutStrategy.PROGRESSIVE_PER_GROUP);
	});
	it("the pilot is a mandatory placement group that runs first", () => {
		expect(fanout.mandatoryGroups).toEqual(["pilot"]);
		expect(placement.groups.map((g) => g.name)).toContain("pilot");
	});
	it("I20: the fan-out is bounded by concurrency and a failure budget, and rolls back on halt", () => {
		expect(fanout.maxConcurrencyPercent).toBe(CD_DEFAULTS.fanoutGroupSizePercent);
		expect(fanout.maxFailuresPercent).toBe(CD_DEFAULTS.fanoutMaxFailuresPercent);
		expect(fanout.rollbackOnHalt).toBe(true);
	});
	it("R10: downstream qualification is a 95 % quorum; late stores match the node", () => {
		expect(storesNode()?.availability).toBe(Availability.QUORUM);
		expect(storesNode()?.quorum?.minQualifiedPercent).toBe(95);
	});
	it("spreads over every region; residency comes from declared Yard regions, not claims", () => {
		expect(placement.spread.map((s) => [s.topologyKey, s.minGroups])).toEqual([["region", 4]]);
		expect(placement.requiredClaims).toEqual([]);
	});
	it("I21: failover is governed: Rail opt-in, one at a time, two signals, GRACEFUL, data kept on departure", () => {
		expect(railDelivery.failover).toMatchObject({ automatic: true, maxConcurrent: 1, requiredSignals: 2, allowImmediatePurge: false });
		expect(storesNode()?.failover?.purge).toBe(PurgeMode.GRACEFUL);
		expect(storesNode()?.departure).toBe(DepartureAction.ORPHAN_DATA);
	});
	it("stays under the Rail's max_fanout_camps", () => {
		expect(railDelivery.maxFanoutCamps).toBe(CD_DEFAULTS.maxFanoutCamps);
	});
});
