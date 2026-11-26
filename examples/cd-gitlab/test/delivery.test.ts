import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { AssemblyRule, ChangeWindowRecordSchema, FreightSourceRecordSchema, PipelineRecordSchema, SubscriptionKind, TrustedPublisherRecordSchema } from "@hobo/cd";
import { runDeliveryRecordsConformance } from "@hobo/conformance";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { delivery, GITLAB_ISSUER, pipeline, publisher, quarterEnd, source } from "../src/hobo.delivery.js";

describe("cd-gitlab delivery module", () => {
	it("passes the delivery-records conformance suite", async () => {
		const report = await runDeliveryRecordsConformance("cd-gitlab", delivery);
		expect(report.failures).toEqual([]);
	});
	it("round-trips every record through the protobuf wire contract", () => {
		expect(fromBinary(PipelineRecordSchema, toBinary(PipelineRecordSchema, pipeline))).toEqual(pipeline);
		expect(fromBinary(FreightSourceRecordSchema, toBinary(FreightSourceRecordSchema, source))).toEqual(source);
		expect(fromBinary(TrustedPublisherRecordSchema, toBinary(TrustedPublisherRecordSchema, publisher))).toEqual(publisher);
		expect(fromBinary(ChangeWindowRecordSchema, toBinary(ChangeWindowRecordSchema, quarterEnd))).toEqual(quarterEnd);
	});
	it("trusts GitLab OIDC only for protected main of the project", () => {
		expect(publisher.issuer).toBe(GITLAB_ISSUER);
		expect(publisher.requiredClaims).toMatchObject({ ref: "main", ref_protected: "true" });
	});
	it("assembles Freight from Git config and the image at the same commit", () => {
		expect(source.assembly).toBe(AssemblyRule.SAME_COMMIT);
		expect(source.subscriptions.map((s) => s.kind).sort()).toEqual([SubscriptionKind.OCI_REPOSITORY, SubscriptionKind.GIT_REPOSITORY].sort());
	});
	it("reads the repository over smart-HTTP from an https locator", () => {
		const git = source.subscriptions.find((s) => s.kind === SubscriptionKind.GIT_REPOSITORY);
		expect(git?.locator).toMatch(/^https:\/\/gitlab\.com\/.+\.git$/);
	});
	it("prod reads only from staging, after a soak, and honours the quarter-end freeze", () => {
		const prod = pipeline.nodes.find((n) => n.name === "prod");
		expect(prod?.fromNodes).toEqual(["staging"]);
		expect(prod?.requiredSoakMs).toBe(7_200_000n);
		expect(prod?.windows).toEqual(["quarter-end"]);
		expect(quarterEnd.rollbackAllowed).toBe(true);
	});
	it("the sample CI file uses an id_token for hobo.cd and no stored HoBo secret", () => {
		const ci = readFileSync(new URL("../ci/.gitlab-ci.yml", import.meta.url), "utf8");
		expect(ci).toMatch(/aud: hobo\.cd/);
		expect(ci).not.toMatch(/HOBO_(TOKEN|SECRET|PASSWORD)/);
	});
});
