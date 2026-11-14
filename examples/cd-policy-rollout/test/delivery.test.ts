import { clone, create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	CD_DEFAULTS,
	Comparator,
	FreightSubject,
	PipelineNodeRecordSchema,
	PipelineRecordSchema,
	PolicyMode,
	RailDeliveryRecordSchema,
	RemediationMode,
	SubscriptionKind,
} from "@hobo/cd";
import { runDeliveryRecordsConformance } from "@hobo/conformance";
import { describe, expect, it } from "vitest";
import { delivery, EXPECTED_DIVERGENCES, informVerification, pipeline, railDelivery, source } from "../src/hobo.delivery.js";

describe("cd-policy-rollout delivery module", () => {
	it("passes the delivery-records conformance suite", async () => {
		const report = await runDeliveryRecordsConformance("cd-policy-rollout", delivery);
		expect(report.failures).toEqual([]);
	});
	it("round-trips every record through the protobuf wire contract", () => {
		expect(fromBinary(PipelineRecordSchema, toBinary(PipelineRecordSchema, pipeline))).toEqual(pipeline);
		expect(fromBinary(RailDeliveryRecordSchema, toBinary(RailDeliveryRecordSchema, railDelivery))).toEqual(railDelivery);
	});
	it("D24: Rail versions are RAIL Freight discovered from Rail approvals", () => {
		expect(pipeline.subject).toBe(FreightSubject.RAIL);
		expect(source.subscriptions[0]?.kind).toBe(SubscriptionKind.HOBO_RAIL);
	});
	it("I23: the ENFORCE node reads only from the INFORM node", () => {
		const [shadow, enforce] = pipeline.nodes;
		expect(shadow?.policyMode).toBe(PolicyMode.INFORM);
		expect(enforce?.policyMode).toBe(PolicyMode.ENFORCE);
		expect(enforce?.fromNodes).toEqual(["shadow"]);
	});
	it("I23: an ENFORCE node with no INFORM node upstream is caught before apply", async () => {
		const enforce = clone(PipelineNodeRecordSchema, pipeline.nodes[1] ?? create(PipelineNodeRecordSchema));
		enforce.fromNodes = [];
		enforce.fromSources = ["rail-eu-storage"];
		const enforceOnly = clone(PipelineRecordSchema, pipeline);
		enforceOnly.nodes = [enforce];
		const report = await runDeliveryRecordsConformance("enforce-without-inform", { ...delivery, pipelines: [enforceOnly] });
		expect(report.failures.map((f) => f.assertion)).toEqual(["enforceFollowsInform"]);
	});
	it("R12: INFORM qualifies at ≤ 2 % noncompliant and only the declared divergences over 24 h; no data fails", () => {
		expect(informVerification.windowMs).toBe(BigInt(CD_DEFAULTS.informWindowMs));
		expect(informVerification.failOnNoData).toBe(true);
		const [ratio, divergence] = informVerification.thresholds;
		expect([ratio?.comparator, ratio?.value]).toEqual([Comparator.LTE, CD_DEFAULTS.informMaxNoncompliantRatio]);
		expect([divergence?.comparator, divergence?.value]).toEqual([Comparator.LTE, EXPECTED_DIVERGENCES]);
	});
	it("D25: posture is bound inform by default and residency stays inform-only", () => {
		expect(railDelivery.posture.map((p) => [p.pack, p.remediation])).toEqual([
			["storage-baseline", RemediationMode.INFORM],
			["eu-residency", RemediationMode.INFORM_ONLY],
		]);
	});
});
