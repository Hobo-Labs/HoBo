// CD spans following the OTel CI/CD semantic conventions (D17). A promotion
// is a pipeline run (`RUN <pipeline>`, SERVER); each target Camp is a task
// run (`promote <campId>`, INTERNAL, task type `deploy`). Spans are a pure
// projection of the promotion stream in the event store, so a trace replays
// byte-identically from the journal (I8): trace and span ids are derived
// from the promotion id, timestamps are the recorded event times.
import { createHash } from "node:crypto";
import { fromJson } from "@bufbuild/protobuf";
import type { EventEnvelope, EventStore, JsonValue } from "@hobo/core";
import {
	FreightSubject,
	PromotionRecordSchema,
	PromotionState,
} from "../_generated/cd_pb.js";
import { isText } from "../authz/json.js";
import { CD_EVENTS, CD_STREAMS } from "../events.js";
import type { CampId, OtelMetricPoint, OtelSpan } from "../ports.js";
import {
	CICD,
	CICD_ACTION,
	CICD_METRICS,
	type CicdResult,
	DEPLOYMENT_ENVIRONMENT_NAME,
	ERROR_TYPE,
	HOBO_ATTR,
} from "./semconv.js";

/** Where a Camp sits (from the topology port, composed by WP18). */
export type CampPlacementRef = Readonly<{
	stationId?: string;
	yardId?: string;
}>;

export type CampLocator = (campId: CampId) => CampPlacementRef | undefined;

const TERMINAL: ReadonlySet<string> = new Set([
	CD_EVENTS.EnvPromoted,
	CD_EVENTS.EnvPromoteRejected,
	CD_EVENTS.EnvPromoteRolledBack,
	CD_EVENTS.EnvPromoteSuperseded,
]);

// Worst first: the run result is the worst task result.
const RESULT_ORDER = Object.freeze([
	"failure",
	"error",
	"timeout",
	"success",
	"cancellation",
	"skip",
] as const satisfies readonly CicdResult[]);

function rank(result: CicdResult): number {
	return RESULT_ORDER.indexOf(result);
}

function hex(seed: string, length: number): string {
	return createHash("sha256").update(seed).digest("hex").slice(0, length);
}

// public-contract: deterministic trace id of a promotion.
export function promotionTraceId(promotionId: string): string {
	return hex(`hobo.cd.trace:${promotionId}`, 32);
}

// public-contract: deterministic span id of a promotion (root) or a Camp task.
export function promotionSpanId(promotionId: string, campId?: string): string {
	return hex(
		campId === undefined
			? `hobo.cd.span:${promotionId}`
			: `hobo.cd.span:${promotionId}:${campId}`,
		16,
	);
}

function resultFor(type: string, state: PromotionState): CicdResult {
	if (type === CD_EVENTS.EnvPromoted) return "success";
	if (type === CD_EVENTS.EnvPromoteRolledBack) return "failure";
	if (type === CD_EVENTS.EnvPromoteSuperseded) return "cancellation";
	if (state === PromotionState.FAILED) return "failure";
	return "skip";
}

function statusFor(result: CicdResult | undefined): OtelSpan["status"] {
	if (result === undefined) return "unset";
	if (result === "success") return "ok";
	if (result === "failure" || result === "error" || result === "timeout")
		return "error";
	return "unset";
}

function parse(event: EventEnvelope) {
	try {
		// SAFETY: event-store bodies are JSON; fromJson parses or throws.
		const data = event.data as JsonValue;
		return fromJson(PromotionRecordSchema, data, { ignoreUnknownFields: true });
	} catch {
		return undefined;
	}
}

function ms(ts: string): number {
	const value = Date.parse(ts);
	return Number.isFinite(value) ? value : 0;
}

function placement(
	locate: CampLocator | undefined,
	campId: string,
	into: Map<string, string>,
): void {
	// SAFETY: the Camp id comes from a recorded PromotionRecord target.
	const ref = locate?.(campId as CampId);
	if (ref?.stationId) into.set(HOBO_ATTR.stationId, ref.stationId);
	if (ref?.yardId) into.set(HOBO_ATTR.yardId, ref.yardId);
}

/**
 * Project one promotion stream into CI/CD spans: one pipeline-run span and one
 * task-run span per target Camp. Returns `[]` for a stream with no request.
 */
export function promotionSpans(
	events: readonly EventEnvelope[],
	locate?: CampLocator,
): OtelSpan[] {
	const requested = events.find(
		(e) => e.type === CD_EVENTS.EnvPromoteRequested,
	);
	const request = requested ? parse(requested) : undefined;
	if (!requested || !request) return [];
	const promotionId = request.promotionId;
	const pipeline = request.pipeline === "" ? "promotion" : request.pipeline;
	const traceId = promotionTraceId(promotionId);
	const rootId = promotionSpanId(promotionId);
	const startMs = ms(requested.ts);
	const environment = (campId: string) =>
		request.node === "" ? campId : request.node;

	const terminal = new Map<string, { atMs: number; result: CicdResult }>();
	for (const event of events) {
		if (!TERMINAL.has(event.type)) continue;
		const record = parse(event);
		const campId = record?.targetCampIds[0];
		if (!record || campId === undefined || terminal.has(campId)) continue;
		terminal.set(campId, {
			atMs: ms(event.ts),
			result: resultFor(event.type, record.state),
		});
	}

	const common = new Map<string, string>([
		[CICD.pipelineName, pipeline],
		[CICD.pipelineRunId, promotionId],
		[HOBO_ATTR.freightId, request.freightId],
		[HOBO_ATTR.promotionId, promotionId],
		[
			HOBO_ATTR.intent,
			request.subject === FreightSubject.RAIL ? "rail" : "bindle",
		],
	]);
	if (request.node !== "") common.set(HOBO_ATTR.pipelineNode, request.node);

	const tasks: OtelSpan[] = [];
	for (const campId of [...request.targetCampIds].sort()) {
		const done = terminal.get(campId);
		const attributes = new Map(common);
		placement(locate, campId, attributes);
		attributes.set(CICD.pipelineTaskName, `promote ${campId}`);
		attributes.set(CICD.pipelineTaskRunId, `${promotionId}/${campId}`);
		attributes.set(CICD.pipelineTaskType, "deploy");
		attributes.set(HOBO_ATTR.campId, campId);
		attributes.set(DEPLOYMENT_ENVIRONMENT_NAME, environment(campId));
		if (done) attributes.set(CICD.pipelineTaskRunResult, done.result);
		tasks.push({
			name: `promote ${campId}`,
			traceId,
			spanId: promotionSpanId(promotionId, campId),
			parentSpanId: rootId,
			kind: "internal",
			startMs,
			endMs: done ? Math.max(startMs, done.atMs) : startMs,
			status: statusFor(done?.result),
			attributes: Object.fromEntries(attributes),
		});
	}

	const results = [...terminal.values()].map((t) => t.result);
	const finished =
		request.targetCampIds.length > 0 &&
		request.targetCampIds.every((c) => terminal.has(c));
	const rootResult = finished
		? results.reduce<CicdResult>(
				(worst, r) => (rank(r) < rank(worst) ? r : worst),
				"skip",
			)
		: undefined;
	const rootAttributes = new Map(common);
	rootAttributes.set(CICD.pipelineActionName, CICD_ACTION.run);
	if (request.targetCampIds.length === 1) {
		const only = request.targetCampIds[0] ?? "";
		placement(locate, only, rootAttributes);
		rootAttributes.set(HOBO_ATTR.campId, only);
		rootAttributes.set(DEPLOYMENT_ENVIRONMENT_NAME, environment(only));
	} else if (request.node !== "")
		rootAttributes.set(DEPLOYMENT_ENVIRONMENT_NAME, request.node);
	if (rootResult) rootAttributes.set(CICD.pipelineResult, rootResult);
	else rootAttributes.set(CICD.pipelineRunState, "executing");
	const endMs = Math.max(startMs, ...tasks.map((t) => t.endMs));
	const root: OtelSpan = {
		name: `${CICD_ACTION.run} ${pipeline}`,
		traceId,
		spanId: rootId,
		kind: "server",
		startMs,
		endMs,
		status: statusFor(rootResult),
		attributes: Object.fromEntries(rootAttributes),
	};
	return [root, ...tasks];
}

/** Read a promotion stream from the event store and project its spans. */
export async function journalPromotionSpans(
	store: EventStore,
	promotionId: string,
	locate?: CampLocator,
): Promise<OtelSpan[]> {
	const events: EventEnvelope[] = [];
	for await (const event of store.read(CD_STREAMS.promotion(promotionId)))
		events.push(event);
	return promotionSpans(events, locate);
}

/**
 * The OTel CI/CD metrics of finished pipeline-run spans:
 * `cicd.pipeline.run.duration` (histogram, seconds, state `executing`) and
 * `cicd.pipeline.run.errors` (counter, `error.type` = the run result) for runs
 * that ended in failure or error.
 */
export function pipelineRunMetrics(
	spans: readonly OtelSpan[],
): OtelMetricPoint[] {
	const points: OtelMetricPoint[] = [];
	for (const span of spans) {
		const result = span.attributes[CICD.pipelineResult];
		const pipeline = span.attributes[CICD.pipelineName];
		if (span.parentSpanId !== undefined || !isText(result) || !isText(pipeline))
			continue;
		points.push({
			name: CICD_METRICS.pipelineRunDuration,
			kind: "histogram",
			value: Math.max(0, span.endMs - span.startMs) / 1_000,
			unit: "s",
			atMs: span.endMs,
			attributes: {
				[CICD.pipelineName]: pipeline,
				[CICD.pipelineRunState]: "executing",
				[CICD.pipelineResult]: result,
			},
		});
		if (result === "failure" || result === "error")
			points.push({
				name: CICD_METRICS.pipelineRunErrors,
				kind: "counter",
				value: 1,
				unit: "{error}",
				atMs: span.endMs,
				attributes: { [CICD.pipelineName]: pipeline, [ERROR_TYPE]: result },
			});
	}
	return points;
}
