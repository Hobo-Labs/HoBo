/**
 * HoBo CD views for the yard world (plan 0024 WP19). Pure, zero-dependency.
 *
 * CD spans follow the OTel CI/CD semantic conventions and carry HoBo topology
 * as SPAN attributes (one CD service delivers to many Camps), so:
 *   - `mapTracePayload` lifts span-level `hobo.camp.id` into a per-Camp
 *     resource (`liftCdTopology` in otel-mapper.ts), so each delivery task
 *     lands in its Camp room as an `actor` character `<service>@<camp>`.
 *   - `parseCdSpans` is the parse boundary for CD spans (parse, don't
 *     validate): only spans with `cicd.pipeline.run.id` become `CdSpan`.
 *   - `freightTimeline` and `pipelineGraph` are model views (projections) over
 *     parsed CD spans: where each Freight went, when, with what result; and
 *     which pipeline nodes Freight flows between.
 *   - `fleetView` and `complianceHeatmap` are projections over the
 *     `hobo.cd.camp.*` and `hobo.cd.compliance.noncompliant_ratio` gauges:
 *     Camps by condition and taint, and noncompliance by Rail and control.
 *   - `renderPromotionTrace` runs a CD trace through the mapper and reducer
 *     and returns the world plus both views — the yard-world rendering of a
 *     promotion.
 *
 * Attribute keys mirror `@hobo/cd/telemetry` (`semconv.ts`); they are copied,
 * not imported, because this package depends on nothing.
 */
import {
	type AgentEvent,
	applyEvent,
	emptyWorld,
	type WorldState,
} from "./model.js";
import {
	attributesToRecord,
	mapTracePayload,
	type OtlpMetricsRequest,
	type OtlpTraceRequest,
} from "./otel-mapper.js";

/** CD attribute keys (OTel CI/CD semconv + HoBo), mirrored from @hobo/cd. */
export const CD_SPAN_ATTR = Object.freeze({
	pipelineName: "cicd.pipeline.name",
	runId: "cicd.pipeline.run.id",
	result: "cicd.pipeline.result",
	runState: "cicd.pipeline.run.state",
	taskName: "cicd.pipeline.task.name",
	taskRunId: "cicd.pipeline.task.run.id",
	taskResult: "cicd.pipeline.task.run.result",
	environment: "deployment.environment.name",
	freightId: "hobo.freight.id",
	campId: "hobo.camp.id",
	stationId: "hobo.station.id",
	yardId: "hobo.yard.id",
	node: "hobo.cd.pipeline.node",
} as const);

/** CD metric names consumed by the fleet views. */
export const CD_FLEET_METRICS = Object.freeze({
	campCondition: "hobo.cd.camp.condition",
	campTaint: "hobo.cd.camp.taint",
	noncompliantRatio: "hobo.cd.compliance.noncompliant_ratio",
} as const);

/** The INFORM noncompliance budget (R12); above it a heatmap cell breaches. */
export const COMPLIANCE_WATCH_RATIO = 0.02;

export type CdResult =
	| "success"
	| "failure"
	| "error"
	| "timeout"
	| "cancellation"
	| "skip"
	| "pending";

const RESULTS: ReadonlySet<string> = new Set([
	"success",
	"failure",
	"error",
	"timeout",
	"cancellation",
	"skip",
]);

function result(value: string | undefined): CdResult {
	if (value === undefined || !RESULTS.has(value)) return "pending";
	// SAFETY: membership in RESULTS was checked on the line above.
	return value as CdResult;
}

/** A parsed CD span: a pipeline run (`taskName` empty) or a task run. */
export interface CdSpan {
	traceId: string;
	spanId: string;
	parentSpanId: string;
	name: string;
	runId: string;
	pipeline: string;
	taskName: string;
	freightId: string;
	campId: string;
	stationId: string;
	node: string;
	environment: string;
	result: CdResult;
	startMs: number;
	endMs: number;
}

function nanoToMs(value: string | number | undefined): number {
	if (value === undefined) return 0;
	const n = typeof value === "string" ? Number(value) : value;
	return Number.isFinite(n) ? Math.floor(n / 1_000_000) : 0;
}

/** Parse boundary: OTLP/JSON → CD spans. Non-CD spans are ignored. */
export function parseCdSpans(payload: OtlpTraceRequest): CdSpan[] {
	const out: CdSpan[] = [];
	for (const rs of payload.resourceSpans ?? []) {
		const resource = attributesToRecord(rs.resource?.attributes);
		for (const ss of rs.scopeSpans ?? [])
			for (const span of ss.spans ?? []) {
				const a = attributesToRecord(span.attributes);
				const runId = a[CD_SPAN_ATTR.runId];
				if (runId === undefined) continue;
				const taskName = a[CD_SPAN_ATTR.taskName] ?? "";
				const campId = a[CD_SPAN_ATTR.campId] ?? resource["hobo.camp"] ?? "";
				out.push({
					traceId: span.traceId,
					spanId: span.spanId,
					parentSpanId: span.parentSpanId ?? "",
					name: span.name,
					runId,
					pipeline: a[CD_SPAN_ATTR.pipelineName] ?? "",
					taskName,
					freightId: a[CD_SPAN_ATTR.freightId] ?? "",
					campId,
					stationId:
						a[CD_SPAN_ATTR.stationId] ?? resource["hobo.station"] ?? "",
					node: a[CD_SPAN_ATTR.node] ?? "",
					environment: a[CD_SPAN_ATTR.environment] ?? campId,
					result: result(
						taskName === ""
							? a[CD_SPAN_ATTR.result]
							: a[CD_SPAN_ATTR.taskResult],
					),
					startMs: nanoToMs(span.startTimeUnixNano),
					endMs: nanoToMs(span.endTimeUnixNano),
				});
			}
	}
	return out;
}

/** One delivery of one Freight to one Camp. */
export interface FreightTimelineEntry {
	freightId: string;
	runId: string;
	pipeline: string;
	node: string;
	campId: string;
	stationId: string;
	environment: string;
	result: CdResult;
	startMs: number;
	endMs: number;
}

export interface FreightTimeline {
	freightId: string;
	entries: FreightTimelineEntry[];
}

function byTime(a: FreightTimelineEntry, b: FreightTimelineEntry): number {
	return (
		a.startMs - b.startMs ||
		a.endMs - b.endMs ||
		a.campId.localeCompare(b.campId) ||
		a.runId.localeCompare(b.runId)
	);
}

/** Freight → its deliveries (task runs), oldest first. Deterministic. */
export function freightTimeline(spans: readonly CdSpan[]): FreightTimeline[] {
	const groups = new Map<string, Map<string, FreightTimelineEntry>>();
	for (const s of spans) {
		if (s.taskName === "" || s.freightId === "" || s.campId === "") continue;
		const entries = groups.get(s.freightId) ?? new Map();
		// One entry per task run; a later report of the same run replaces it.
		entries.set(`${s.runId}\u0000${s.campId}`, {
			freightId: s.freightId,
			runId: s.runId,
			pipeline: s.pipeline,
			node: s.node,
			campId: s.campId,
			stationId: s.stationId,
			environment: s.environment,
			result: s.result,
			startMs: s.startMs,
			endMs: s.endMs,
		});
		groups.set(s.freightId, entries);
	}
	return [...groups.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([freightId, entries]) => ({
			freightId,
			entries: [...entries.values()].sort(byTime),
		}));
}

export interface PipelineGraphNode {
	id: string;
	camps: string[];
	lastFreightId: string;
	lastResult: CdResult;
	lastAtMs: number;
}

export interface PipelineGraphEdge {
	from: string;
	to: string;
	/** Distinct Freight seen moving along this edge. */
	freightCount: number;
}

export interface PipelineGraph {
	pipeline: string;
	nodes: PipelineGraphNode[];
	edges: PipelineGraphEdge[];
}

/**
 * Pipeline → node graph observed from task runs. A node is the span's
 * pipeline node (else its environment); an edge joins consecutive nodes a
 * Freight reached, in time order.
 */
export function pipelineGraph(spans: readonly CdSpan[]): PipelineGraph[] {
	const pipelines = new Map<string, FreightTimelineEntry[]>();
	for (const timeline of freightTimeline(spans))
		for (const e of timeline.entries) {
			const list = pipelines.get(e.pipeline) ?? [];
			list.push(e);
			pipelines.set(e.pipeline, list);
		}
	return [...pipelines.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([pipeline, entries]) => {
			const nodeOf = (e: FreightTimelineEntry) => e.node || e.environment;
			const nodes = new Map<string, PipelineGraphNode>();
			for (const e of [...entries].sort(byTime)) {
				const id = nodeOf(e);
				const node = nodes.get(id) ?? {
					id,
					camps: [],
					lastFreightId: "",
					lastResult: "pending",
					lastAtMs: Number.NEGATIVE_INFINITY,
				};
				if (!node.camps.includes(e.campId)) node.camps.push(e.campId);
				if (e.startMs >= node.lastAtMs) {
					node.lastAtMs = e.startMs;
					node.lastFreightId = e.freightId;
					node.lastResult = e.result;
				}
				nodes.set(id, node);
			}
			const edgeFreight = new Map<string, Set<string>>();
			const byFreight = new Map<string, FreightTimelineEntry[]>();
			for (const e of entries) {
				const list = byFreight.get(e.freightId) ?? [];
				list.push(e);
				byFreight.set(e.freightId, list);
			}
			for (const [freightId, list] of byFreight) {
				const order: string[] = [];
				for (const e of [...list].sort(byTime)) {
					const id = nodeOf(e);
					if (order[order.length - 1] !== id && !order.includes(id))
						order.push(id);
				}
				for (let i = 1; i < order.length; i += 1) {
					const key = `${order[i - 1]}\u0000${order[i]}`;
					const set = edgeFreight.get(key) ?? new Set();
					set.add(freightId);
					edgeFreight.set(key, set);
				}
			}
			return {
				pipeline,
				nodes: [...nodes.values()]
					.map((n) => ({ ...n, camps: [...n.camps].sort() }))
					.sort((a, b) => a.lastAtMs - b.lastAtMs || a.id.localeCompare(b.id)),
				edges: [...edgeFreight.entries()]
					.map(([key, set]) => {
						const [from = "", to = ""] = key.split("\u0000");
						return { from, to, freightCount: set.size };
					})
					.sort(
						(a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
					),
			};
		});
}

export interface PromotionTraceRendering {
	world: WorldState;
	events: AgentEvent[];
	spans: CdSpan[];
	timeline: FreightTimeline[];
	graph: PipelineGraph[];
}

/**
 * Render a CD trace: lift topology, map and reduce it into a world (starting
 * from `world`, default empty), and project the Freight timeline and pipeline
 * graph. Pure apart from structured cloning in the reducer.
 */
export function renderPromotionTrace(
	payload: OtlpTraceRequest,
	now: number,
	world: WorldState = emptyWorld(),
): PromotionTraceRendering {
	const state = structuredClone(world);
	const events = mapTracePayload(payload, state, now);
	const reduced = events.reduce(applyEvent, state);
	const spans = parseCdSpans(payload);
	return {
		world: reduced,
		events,
		spans,
		timeline: freightTimeline(spans),
		graph: pipelineGraph(spans),
	};
}

// ── Fleet views (metrics) ─────────────────────────────────────────────────

export interface FleetCampRow {
	campId: string;
	/** condition → status (`true` | `false` | `unknown`). */
	conditions: Record<string, string>;
	taints: { key: string; effect: string }[];
}

export interface FleetView {
	camps: FleetCampRow[];
	/** condition → status → Camp ids. */
	byCondition: Record<string, Record<string, string[]>>;
	/** taint effect → Camp ids. */
	byTaint: Record<string, string[]>;
	untainted: string[];
}

type OtlpMetric = NonNullable<
	NonNullable<
		NonNullable<OtlpMetricsRequest["resourceMetrics"]>[number]["scopeMetrics"]
	>[number]["metrics"]
>[number];

function gaugePoints(payload: OtlpMetricsRequest, name: string) {
	const out: { attrs: Record<string, string>; value: number; atMs: number }[] =
		[];
	for (const rm of payload.resourceMetrics ?? [])
		for (const sm of rm.scopeMetrics ?? [])
			for (const metric of sm.metrics ?? []) {
				const m: OtlpMetric = metric;
				if (m.name !== name) continue;
				for (const p of [
					...(m.gauge?.dataPoints ?? []),
					...(m.sum?.dataPoints ?? []),
				]) {
					const value = p.asDouble ?? Number(p.asInt ?? Number.NaN);
					if (!Number.isFinite(value)) continue;
					out.push({
						attrs: attributesToRecord(p.attributes),
						value,
						atMs: nanoToMs(p.timeUnixNano),
					});
				}
			}
	return out;
}

/** Camps by condition and taint, from `hobo.cd.camp.*` gauges. */
export function fleetView(payload: OtlpMetricsRequest): FleetView {
	const rows = new Map<string, FleetCampRow>();
	const row = (campId: string): FleetCampRow => {
		let r = rows.get(campId);
		if (r === undefined) {
			r = { campId, conditions: {}, taints: [] };
			rows.set(campId, r);
		}
		return r;
	};
	for (const p of gaugePoints(payload, CD_FLEET_METRICS.campCondition)) {
		const campId = p.attrs["hobo.camp.id"];
		const condition = p.attrs["hobo.camp.condition"];
		if (!campId || !condition || p.value <= 0) continue;
		row(campId).conditions[condition] =
			p.attrs["hobo.camp.condition.status"] ?? "unknown";
	}
	for (const p of gaugePoints(payload, CD_FLEET_METRICS.campTaint)) {
		const campId = p.attrs["hobo.camp.id"];
		const key = p.attrs["hobo.camp.taint.key"];
		if (!campId || !key || p.value <= 0) continue;
		const effect = p.attrs["hobo.camp.taint.effect"] ?? "unspecified";
		const r = row(campId);
		if (!r.taints.some((t) => t.key === key && t.effect === effect))
			r.taints.push({ key, effect });
	}
	const camps = [...rows.values()]
		.map((r) => ({
			...r,
			taints: [...r.taints].sort(
				(a, b) =>
					a.key.localeCompare(b.key) || a.effect.localeCompare(b.effect),
			),
		}))
		.sort((a, b) => a.campId.localeCompare(b.campId));
	const byCondition: Record<string, Record<string, string[]>> = {};
	const byTaint: Record<string, string[]> = {};
	const untainted: string[] = [];
	for (const c of camps) {
		for (const [condition, status] of Object.entries(c.conditions)) {
			const statuses = byCondition[condition] ?? {};
			statuses[status] = [...(statuses[status] ?? []), c.campId];
			byCondition[condition] = statuses;
		}
		if (c.taints.length === 0) untainted.push(c.campId);
		for (const effect of new Set(c.taints.map((t) => t.effect)))
			byTaint[effect] = [...(byTaint[effect] ?? []), c.campId];
	}
	return { camps, byCondition, byTaint, untainted };
}

export type HeatBand = "ok" | "watch" | "breach";

export interface ComplianceCell {
	rail: string;
	control: string;
	mode: string;
	ratio: number;
	band: HeatBand;
}

export interface ComplianceHeatmap {
	rails: string[];
	/** `*` (overall) first, then controls alphabetically. */
	controls: string[];
	cells: ComplianceCell[];
}

export function heatBand(ratio: number): HeatBand {
	if (ratio <= 0) return "ok";
	return ratio <= COMPLIANCE_WATCH_RATIO ? "watch" : "breach";
}

/** Noncompliance by Rail × control, latest point per cell. */
export function complianceHeatmap(
	payload: OtlpMetricsRequest,
): ComplianceHeatmap {
	const latest = new Map<string, { cell: ComplianceCell; atMs: number }>();
	for (const p of gaugePoints(payload, CD_FLEET_METRICS.noncompliantRatio)) {
		const rail = p.attrs["hobo.rail.digest"];
		const control = p.attrs["hobo.policy.control"];
		if (!rail || !control) continue;
		const mode = p.attrs["hobo.policy.mode"] ?? "enforce";
		const key = `${rail}\u0000${control}\u0000${mode}`;
		const prior = latest.get(key);
		if (prior && prior.atMs > p.atMs) continue;
		const ratio = Math.max(0, Math.min(1, p.value));
		latest.set(key, {
			cell: { rail, control, mode, ratio, band: heatBand(ratio) },
			atMs: p.atMs,
		});
	}
	const cells = [...latest.values()]
		.map((x) => x.cell)
		.sort(
			(a, b) =>
				a.rail.localeCompare(b.rail) ||
				(a.control === "*"
					? -1
					: b.control === "*"
						? 1
						: a.control.localeCompare(b.control)) ||
				a.mode.localeCompare(b.mode),
		);
	const rails = [...new Set(cells.map((c) => c.rail))].sort();
	const controls = [...new Set(cells.map((c) => c.control))].sort((a, b) =>
		a === "*" ? -1 : b === "*" ? 1 : a.localeCompare(b),
	);
	return { rails, controls, cells };
}
