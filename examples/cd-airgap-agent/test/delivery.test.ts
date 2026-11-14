import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { FreightSourceRecordSchema, PipelineRecordSchema, RailDeliveryRecordSchema } from "@hobo/cd";
import { createEgressGuard, runDeliveryRecordsConformance } from "@hobo/conformance";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { delivery, pipeline, railDelivery, source, STATION_FEED, YARD_HOSTS } from "../src/hobo.delivery.js";

const host = (locator: string) => new URL(locator.includes("://") ? locator : `https://${locator}`).host;

describe("cd-airgap-agent delivery module", () => {
	it("passes the delivery-records conformance suite", async () => {
		const report = await runDeliveryRecordsConformance("cd-airgap-agent", delivery);
		expect(report.failures).toEqual([]);
	});
	it("round-trips every record through the protobuf wire contract", () => {
		expect(fromBinary(PipelineRecordSchema, toBinary(PipelineRecordSchema, pipeline))).toEqual(pipeline);
		expect(fromBinary(FreightSourceRecordSchema, toBinary(FreightSourceRecordSchema, source))).toEqual(source);
		expect(fromBinary(RailDeliveryRecordSchema, toBinary(RailDeliveryRecordSchema, railDelivery))).toEqual(railDelivery);
	});
	it("§10 WP20: every source and the feed resolve inside the Yard; the egress guard admits them and nothing else", async () => {
		const reached: string[] = [];
		const guard = createEgressGuard(YARD_HOSTS, async (request) => {
			reached.push(new URL(request.url).host);
			return { status: 200, headers: {}, body: "" };
		});
		const locators = [...source.subscriptions.map((s) => s.locator), STATION_FEED];
		for (const locator of locators) {
			expect(YARD_HOSTS).toContain(host(locator));
			await guard.transport({ method: "GET", url: `https://${host(locator)}/`, headers: {}, timeoutMs: 1_000, maxResponseBytes: 1 });
		}
		await expect(guard.transport({ method: "GET", url: "https://ghcr.io/v2/", headers: {}, timeoutMs: 1_000, maxResponseBytes: 1 })).rejects.toThrow(/egress/);
		expect(guard.refused()).toEqual(["ghcr.io"]);
		expect(new Set(reached)).toEqual(new Set(YARD_HOSTS));
	});
	it("I24: agents need two grants from separate principals; no scope is auto-accepted", () => {
		expect(railDelivery.enrollment?.separateApprovers).toBe(true);
		expect(railDelivery.enrollment?.autoAcceptScopes).toEqual([]);
	});
	it("credentials are local file refs resolved by the agent, never inline", () => {
		for (const sub of source.subscriptions) expect(sub.credentialRef).toMatch(/^file:\/\/\/etc\/hobo\//);
	});
	it("the offline install runbook uses only the CLI distribution and in-Yard hosts", () => {
		const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
		expect(readme).toMatch(/hobo deploy agent enroll/);
		expect(readme).toMatch(/hobo deploy agent run/);
		const urls = [...readme.matchAll(/https:\/\/([a-z0-9.-]+)/gu)].map((m) => m[1]);
		for (const u of urls) expect(YARD_HOSTS).toContain(u);
	});
});
