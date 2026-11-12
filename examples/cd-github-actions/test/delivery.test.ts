import { fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	ChangeWindowRecordSchema,
	FreightSourceRecordSchema,
	PipelineRecordSchema,
	RolloutStrategy,
	TrustedPublisherRecordSchema,
} from "@hobo/cd";
import { runDeliveryRecordsConformance } from "@hobo/conformance";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { delivery, GITHUB_ISSUER, pipeline, publisher, RELEASE_WORKFLOW, source, weekendFreeze } from "../src/hobo.delivery.js";

describe("cd-github-actions delivery module", () => {
	it("passes the delivery-records conformance suite", async () => {
		const report = await runDeliveryRecordsConformance("cd-github-actions", delivery);
		expect(report.failures).toEqual([]);
	});
	it("round-trips every record through the protobuf wire contract", () => {
		expect(fromBinary(PipelineRecordSchema, toBinary(PipelineRecordSchema, pipeline))).toEqual(pipeline);
		expect(fromBinary(FreightSourceRecordSchema, toBinary(FreightSourceRecordSchema, source))).toEqual(source);
		expect(fromBinary(TrustedPublisherRecordSchema, toBinary(TrustedPublisherRecordSchema, publisher))).toEqual(publisher);
		expect(fromBinary(ChangeWindowRecordSchema, toBinary(ChangeWindowRecordSchema, weekendFreeze))).toEqual(weekendFreeze);
	});
	it("trusts only the GitHub OIDC issuer for the release workflow, by exact claim", () => {
		expect(publisher.issuer).toBe(GITHUB_ISSUER);
		expect(Object.keys(publisher.requiredClaims).sort()).toEqual(["environment", "repository", "workflow_ref"]);
	});
	it("requires provenance signed by the release workflow", () => {
		const [sub] = source.subscriptions;
		expect(sub?.requireProvenance).toBe(true);
		expect(sub?.trustedSignerIdentities).toEqual([RELEASE_WORKFLOW]);
	});
	it("gates prod behind staging lineage, soak, approval, canary and the weekend freeze", () => {
		const prod = pipeline.nodes.find((node) => node.name === "prod");
		expect(prod?.fromNodes).toEqual(["staging"]);
		expect(prod?.approvalRequired).toBe(true);
		expect(prod?.strategy).toBe(RolloutStrategy.CANARY);
		expect(prod?.verification?.failOnNoData).toBe(true);
		expect(prod?.windows).toEqual(["weekend-freeze"]);
	});
	it("the sample workflow requests an OIDC token and stores no HoBo secret", () => {
		const workflow = readFileSync(new URL("../ci/release.yml", import.meta.url), "utf8");
		expect(workflow).toMatch(/id-token: write/);
		expect(workflow).toMatch(/audience=hobo\.cd/);
		expect(workflow).not.toMatch(/secrets\.HOBO/);
	});
});
