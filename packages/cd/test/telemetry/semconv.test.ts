// WP19 Accept: "Span attributes validate against the semconv registry snapshot
// pinned in the test", plus the R8 lock: STANDARDS.lock.json, SEMCONV and the
// snapshot name the same release. Golden test: the promotion trace of a
// recorded journal is byte-stable.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PromotionState } from "../../src/_generated/cd_pb.js";
import {
	CD_METRICS,
	CICD,
	CICD_METRICS,
	DEPLOYMENT_ENVIRONMENT_NAME,
	encodeTraces,
	HOBO_ATTR,
	journalPromotionSpans,
	pipelineRunMetrics,
	promotionSpanId,
	promotionTraceId,
	SEMCONV,
} from "../../src/telemetry/index.js";
import { clock, MemoryEventStore, MINUTE, T0 } from "../authz/memory-store.js";
import {
	type Journal,
	promoted,
	rejected,
	requestPromotion,
} from "./journal.js";
import {
	attributeProblems,
	METRIC_DEFINITIONS,
	REGISTRY_VERSION,
	SPAN_DEFINITIONS,
} from "./semconv-registry.js";

const lock = JSON.parse(
	readFileSync(
		new URL("../../src/telemetry/STANDARDS.lock.json", import.meta.url),
		"utf8",
	),
);

const LOCATE = (campId: string) =>
	campId === "prod-eu"
		? { stationId: "station-eu", yardId: "yard-eu" }
		: { stationId: "station-us", yardId: "yard-us" };

async function promotionJournal(): Promise<Journal> {
	const c = clock();
	const j: Journal = { store: new MemoryEventStore(c.now), clock: c };
	const p = {
		promotionId: "promo_1",
		freightId: "sha256:abc",
		targets: ["prod-eu", "prod-us"],
		pipeline: "web",
		node: "prod",
	};
	await requestPromotion(j, T0, p);
	await promoted(j, T0 + 4 * MINUTE, p, "prod-eu");
	await rejected(j, T0 + 6 * MINUTE, p, "prod-us", PromotionState.FAILED);
	return j;
}

describe("semantic-conventions pin (R8)", () => {
	it("STANDARDS.lock.json, SEMCONV and the registry snapshot agree", () => {
		expect(lock.version).toBe(SEMCONV.version);
		expect(lock.tag).toBe(`v${SEMCONV.version}`);
		expect(lock.schemaUrl).toBe(SEMCONV.schemaUrl);
		expect(REGISTRY_VERSION).toBe(SEMCONV.version);
		expect(lock.otlp.protocol).toBe("http/json");
	});

	it("every CICD key constant is a registry attribute", () => {
		for (const key of [...Object.values(CICD), DEPLOYMENT_ENVIRONMENT_NAME])
			expect(
				attributeProblems({
					[key]: key.endsWith("action.name") ? "RUN" : "x",
				}).filter((p) => p.includes("not in the semconv")),
			).toEqual([]);
		for (const name of Object.values(CICD_METRICS))
			expect(METRIC_DEFINITIONS[name]).toBeDefined();
		for (const name of Object.values(CD_METRICS))
			expect(name.startsWith("hobo.cd.")).toBe(true);
	});
});

describe("CD spans", () => {
	it("span attributes validate against the pinned semconv registry snapshot", async () => {
		const j = await promotionJournal();
		const spans = await journalPromotionSpans(j.store, "promo_1", LOCATE);
		expect(spans).toHaveLength(3);
		for (const span of spans)
			expect(attributeProblems(span.attributes)).toEqual([]);
		const [root, ...tasks] = spans;
		const run = SPAN_DEFINITIONS.pipelineRun;
		expect(root?.kind).toBe(run.kind);
		expect(root?.name).toMatch(run.namePattern);
		for (const key of [...run.required, ...run.recommended])
			expect(root?.attributes[key]).toBeDefined();
		for (const task of tasks) {
			const def = SPAN_DEFINITIONS.taskRun;
			expect(task.kind).toBe(def.kind);
			expect(task.name).toBe(task.attributes[CICD.pipelineTaskName]);
			for (const key of [...def.required, ...def.recommended])
				expect(task.attributes[key]).toBeDefined();
			expect(task.parentSpanId).toBe(root?.spanId);
			expect(task.traceId).toBe(root?.traceId);
		}
	});

	it("carry the HoBo attributes and the right results (golden)", async () => {
		const j = await promotionJournal();
		const spans = await journalPromotionSpans(j.store, "promo_1", LOCATE);
		expect(spans).toEqual([
			{
				name: "RUN web",
				traceId: promotionTraceId("promo_1"),
				spanId: promotionSpanId("promo_1"),
				kind: "server",
				startMs: T0,
				endMs: T0 + 6 * MINUTE,
				status: "error",
				attributes: {
					[CICD.pipelineName]: "web",
					[CICD.pipelineRunId]: "promo_1",
					[CICD.pipelineActionName]: "RUN",
					[CICD.pipelineResult]: "failure",
					[HOBO_ATTR.freightId]: "sha256:abc",
					[HOBO_ATTR.promotionId]: "promo_1",
					[HOBO_ATTR.intent]: "bindle",
					[HOBO_ATTR.pipelineNode]: "prod",
					[DEPLOYMENT_ENVIRONMENT_NAME]: "prod",
				},
			},
			{
				name: "promote prod-eu",
				traceId: promotionTraceId("promo_1"),
				spanId: promotionSpanId("promo_1", "prod-eu"),
				parentSpanId: promotionSpanId("promo_1"),
				kind: "internal",
				startMs: T0,
				endMs: T0 + 4 * MINUTE,
				status: "ok",
				attributes: {
					[CICD.pipelineName]: "web",
					[CICD.pipelineRunId]: "promo_1",
					[HOBO_ATTR.freightId]: "sha256:abc",
					[HOBO_ATTR.promotionId]: "promo_1",
					[HOBO_ATTR.intent]: "bindle",
					[HOBO_ATTR.pipelineNode]: "prod",
					[HOBO_ATTR.stationId]: "station-eu",
					[HOBO_ATTR.yardId]: "yard-eu",
					[CICD.pipelineTaskName]: "promote prod-eu",
					[CICD.pipelineTaskRunId]: "promo_1/prod-eu",
					[CICD.pipelineTaskType]: "deploy",
					[HOBO_ATTR.campId]: "prod-eu",
					[DEPLOYMENT_ENVIRONMENT_NAME]: "prod",
					[CICD.pipelineTaskRunResult]: "success",
				},
			},
			expect.objectContaining({
				name: "promote prod-us",
				status: "error",
				endMs: T0 + 6 * MINUTE,
				attributes: expect.objectContaining({
					[CICD.pipelineTaskRunResult]: "failure",
					[HOBO_ATTR.stationId]: "station-us",
				}),
			}),
		]);
	});

	it("an unfinished promotion is an executing run with open tasks", async () => {
		const c = clock();
		const j: Journal = { store: new MemoryEventStore(c.now), clock: c };
		const p = {
			promotionId: "promo_2",
			freightId: "sha256:abc",
			targets: ["c-1"],
		};
		await requestPromotion(j, T0, p);
		const [root, task] = await journalPromotionSpans(j.store, "promo_2");
		expect(root?.attributes[CICD.pipelineRunState]).toBe("executing");
		expect(root?.attributes[CICD.pipelineResult]).toBeUndefined();
		expect(root?.name).toBe("RUN promotion");
		expect(root?.attributes[HOBO_ATTR.campId]).toBe("c-1");
		expect(task?.status).toBe("unset");
		for (const span of [root, task])
			expect(attributeProblems(span?.attributes ?? {})).toEqual([]);
	});

	it("no promotion request means no spans", async () => {
		expect(
			await journalPromotionSpans(new MemoryEventStore(), "missing"),
		).toEqual([]);
	});

	it("pipeline-run metrics validate against the snapshot", async () => {
		const j = await promotionJournal();
		const points = pipelineRunMetrics(
			await journalPromotionSpans(j.store, "promo_1", LOCATE),
		);
		expect(points.map((p) => p.name)).toEqual([
			CICD_METRICS.pipelineRunDuration,
			CICD_METRICS.pipelineRunErrors,
		]);
		for (const point of points) {
			const def = METRIC_DEFINITIONS[point.name];
			expect(def?.instrument).toBe(point.kind);
			expect(def?.unit).toBe(point.unit);
			for (const key of def?.required ?? [])
				expect(point.attributes[key]).toBeDefined();
			expect(attributeProblems(point.attributes)).toEqual([]);
		}
		expect(points[0]?.value).toBe(360);
	});

	it("encode to OTLP JSON with the pinned schema URL", async () => {
		const j = await promotionJournal();
		const spans = await journalPromotionSpans(j.store, "promo_1", LOCATE);
		const body = encodeTraces(spans, { "service.name": "hobo-cd" });
		const scope = body.resourceSpans[0]?.scopeSpans[0];
		expect(scope?.schemaUrl).toBe(SEMCONV.schemaUrl);
		expect(scope?.spans[0]).toMatchObject({
			kind: 2,
			startTimeUnixNano: `${T0}000000`,
			status: { code: 2 },
		});
		expect(scope?.spans[1]?.parentSpanId).toBe(promotionSpanId("promo_1"));
	});
});
