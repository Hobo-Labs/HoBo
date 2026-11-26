import { create } from "@bufbuild/protobuf";
import type { JsonObject } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	ArtifactKind,
	SelectionStrategy,
	SubscriptionKind,
	SubscriptionRecordSchema,
} from "../../src/_generated/cd_pb.js";
import type { CiEventReader } from "../../src/ports.js";
import { createCiDriver } from "../../src/sources/drivers/hobo-ci.js";
import { createRailDriver } from "../../src/sources/drivers/hobo-rail.js";
import { encode } from "../../src/sources/json.js";
import {
	clock,
	context,
	digestOf,
	type RailEvent,
	railReader,
	signal,
} from "./support.js";

const railSub = create(SubscriptionRecordSchema, {
	name: "rail",
	kind: SubscriptionKind.HOBO_RAIL,
	locator: "rail-prod",
});
const D1 = digestOf("rail-v1");
const D2 = digestOf("rail-v2");
const D3 = digestOf("rail-v3");

describe("HOBO_RAIL driver", () => {
	it("discovers one artifact per approved Rail digest; a digest approved twice is discovered once", async () => {
		const reader = railReader([
			{
				cursor: "1",
				railId: "rail-prod",
				railDigest: D1,
				status: "approved",
				stationId: "st",
			},
			{
				cursor: "2",
				railId: "rail-prod",
				railDigest: D1,
				status: "active",
				stationId: "st",
			},
			{
				cursor: "3",
				railId: "rail-prod",
				railDigest: D1,
				status: "approved",
				stationId: "st",
			},
			{
				cursor: "4",
				railId: "rail-other",
				railDigest: D2,
				status: "approved",
				stationId: "st",
			},
		]);
		const outcome = await createRailDriver({ readRailEvents: reader }).discover(
			{ source: "rails", subscription: railSub, signal },
			context(clock().now),
		);
		if (!outcome.ok) throw new Error("rail");
		expect(outcome.value.artifacts.map((item) => item.version)).toEqual([D1]);
		expect(outcome.value.artifacts[0]?.artifact?.coordinate).toBe(
			`rail:rail-prod@${D1}`,
		);
	});

	it("never discovers a retired Rail and resumes after its cursor", async () => {
		const events: RailEvent[] = [
			{
				cursor: "1",
				railId: "rail-prod",
				railDigest: D1,
				status: "approved",
				stationId: "st",
			},
			{
				cursor: "2",
				railId: "rail-prod",
				railDigest: D1,
				status: "retired",
				stationId: "st",
			},
			{
				cursor: "3",
				railId: "rail-prod",
				railDigest: D2,
				status: "approved",
				stationId: "st",
			},
		];
		const driver = createRailDriver({ readRailEvents: railReader(events) });
		const ctx = context(clock().now);
		const first = await driver.discover(
			{ source: "rails", subscription: railSub, signal },
			ctx,
		);
		if (!first.ok) throw new Error("rail");
		expect(first.value.artifacts.map((item) => item.version)).toEqual([D2]);
		events.push({
			cursor: "4",
			railId: "rail-prod",
			railDigest: D3,
			status: "approved",
			stationId: "st",
		});
		const second = await driver.discover(
			{
				source: "rails",
				subscription: railSub,
				cursor: first.value.cursor,
				signal,
			},
			ctx,
		);
		expect(
			second.ok && second.value.artifacts.map((item) => item.version),
		).toEqual([D3]);
	});

	it("refuses without a RailEventReader", async () => {
		const outcome = await createRailDriver({}).discover(
			{ source: "rails", subscription: railSub, signal },
			context(clock().now),
		);
		expect(!outcome.ok && outcome.reasons[0]?.code).toBe(
			"source-driver-unavailable",
		);
	});
});

const bundle = encode("wasm-bytes");

type CiEvent = Readonly<{ cursor: string; type: string; data: JsonObject }>;

function ciEvent(
	cursor: string,
	runId: string,
	status: string,
	sha: string,
	pipelineId = "web-build",
): CiEvent {
	const lease = {
		id: `lease-${runId}`,
		pipelineId,
		repository: "acme/web",
		headSha: "c".repeat(40),
		result: {
			id: runId,
			backend: "dagger",
			status,
			artifacts: [{ path: "dist/web.wasm", sha256: sha }],
		},
	};
	return {
		cursor,
		type: "ci.PipelineResultObserved",
		data: { type: "ci.PipelineResultObserved", detail: JSON.stringify(lease) },
	};
}

function ciReader(
	events: ReadonlyArray<
		Readonly<{ cursor: string; type: string; data: JsonObject }>
	>,
): CiEventReader {
	return async function* (after) {
		const start =
			after === undefined
				? 0
				: events.findIndex((event) => event.cursor === after) + 1;
		for (const event of events.slice(start)) yield event;
	};
}

const ciSub = create(SubscriptionRecordSchema, {
	name: "wasm",
	kind: SubscriptionKind.HOBO_CI,
	locator: "web-build",
	selection: SelectionStrategy.NEWEST_BUILD,
	artifactName: "dist/web.wasm",
	artifactKind: ArtifactKind.WASM_COMPONENT,
});

describe("HOBO_CI driver", () => {
	it("discovers outputs of passing runs, verified by reading the bytes back", async () => {
		const sha = digestOf(bundle).slice(7);
		const driver = createCiDriver({
			readCiEvents: ciReader([
				ciEvent("1", "run-1", "failed", sha),
				ciEvent("2", "run-2", "passed", sha),
				{ cursor: "3", type: "ci.JobQueued", data: {} },
				ciEvent("4", "run-3", "passed", sha, "other-pipeline"),
			]),
			readCiArtifact: async (runId, path) =>
				runId === "run-2" && path === "dist/web.wasm" ? bundle : undefined,
		});
		const outcome = await driver.discover(
			{ source: "web", subscription: ciSub, signal },
			context(clock().now),
		);
		if (!outcome.ok) throw new Error(JSON.stringify(outcome.reasons));
		expect(
			outcome.value.artifacts.map((item) => [
				item.version,
				item.artifact?.digest,
				item.commit,
			]),
		).toEqual([["run-2", digestOf(bundle), "c".repeat(40)]]);
		expect(JSON.parse(outcome.value.cursor)).toEqual({ at: "4" });
	});

	it("refuses when the read-back bytes differ from the recorded sha256", async () => {
		const driver = createCiDriver({
			readCiEvents: ciReader([
				ciEvent("1", "run-1", "passed", digestOf(bundle).slice(7)),
			]),
			readCiArtifact: async () => encode("tampered"),
		});
		const outcome = await driver.discover(
			{ source: "web", subscription: ciSub, signal },
			context(clock().now),
		);
		expect(!outcome.ok && outcome.reasons[0]?.code).toBe(
			"source-upstream-invalid",
		);
	});
});
