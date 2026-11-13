// `createCdControlApi` — the `/v1/cd/` HTTP surface the control API mounts
// (WP12). Read routes (pipelines, Freight timeline, promotions, Camps,
// inventory, placement decisions, fan-outs, failovers, compliance, readiness,
// OpenAPI, SSE stream) are answered here from the module ports; every other
// `/v1/cd/` path is handed to the delivery feed unchanged, so one mount
// serves operators and agents. The surface is read-only: mutations go through
// the governed commands (`hobo deploy`, MCP), never through this API.
import type { DurableEventStore } from "@hobo/core";
import type {
	ContinuousDelivery,
	FeedRequest,
	FeedResponse,
	HealthReport,
	OtelMetricPoint,
	Outcome,
	TelemetrySink,
	TopologyReader,
} from "../ports.js";
import {
	isStoreFailure,
	messageOf,
	serviceReason,
	serviceRefusal,
} from "./errors.js";
import { type CdOpenApiDocument, cdOpenApi } from "./openapi.js";
import { type CdReadRoute, parseReadRequest } from "./routes.js";
import { cdEventStream, STREAM_DEFAULTS } from "./stream.js";
import {
	campInventoryView,
	campStatusView,
	campsView,
	complianceView,
	failoversView,
	fanoutView,
	freightTimeline,
	pipelineView,
	placementDecisionView,
	promotionsView,
	type ViewDeps,
} from "./views.js";
import {
	okResponse,
	rawJsonResponse,
	refusalResponse,
	sseResponse,
	type WireValue,
} from "./wire.js";

// public-contract: metric names the read API emits through TelemetrySink.
export const CD_API_METRICS = Object.freeze({
	requests: "hobo.cd.api.requests",
	requestMs: "hobo.cd.api.request_ms",
	streamFrames: "hobo.cd.api.stream_frames",
});

export type CdControlApiDeps = Readonly<{
	store: Pick<DurableEventStore, "read" | "readAll">;
	tenant: string;
	now: () => number;
	cd: Pick<
		ContinuousDelivery,
		| "pipelines"
		| "freight"
		| "promotions"
		| "desired"
		| "inventory"
		| "placement"
		| "fanout"
		| "failover"
		| "posture"
		| "feed"
	>;
	/** Declared topology for `/camps/{id}/inventory` (composed by WP18). */
	topology?: TopologyReader;
	/** The service host, for `/v1/cd/ready`. Without it readiness is 503. */
	service?: Readonly<{ health(): HealthReport }>;
	telemetry?: TelemetrySink;
	streamPollMs?: number;
	streamHeartbeatMs?: number;
	streamMaxMs?: number;
	streamBatch?: number;
}>;

export interface CdControlApi {
	readonly pathPrefix: "/v1/cd/";
	handle(request: FeedRequest, signal: AbortSignal): Promise<FeedResponse>;
	/** The OpenAPI document of the read routes (merged into the control API's). */
	openapi(): CdOpenApiDocument;
}

/** Metric label: the first path segment under /v1/cd/ (bounded, no ids). */
function segmentOf(path: string): string {
	const pathname = new URL(path, "http://cd.invalid").pathname;
	return pathname.slice("/v1/cd/".length).split("/")[0] || "root";
}

export function createCdControlApi(d: CdControlApiDeps): CdControlApi {
	const views: ViewDeps = { cd: d.cd, store: d.store, topology: d.topology };

	function emit(points: readonly OtelMetricPoint[]): void {
		d.telemetry?.metrics(points).catch(() => {
			// Telemetry is best-effort.
		});
	}

	function ready(): FeedResponse {
		const report = d.service?.health();
		if (report?.ok) return okResponse(report);
		const failing = report?.checks.filter((c) => !c.ok) ?? [];
		const reasons =
			failing.length > 0
				? failing.map((c) => serviceReason("not-ready", c.detail, c.name))
				: [
						serviceReason(
							"not-ready",
							report ? "not ready" : "no CD service is attached to this API",
							"service",
						),
					];
		return refusalResponse({ ok: false, reasons });
	}

	async function view(
		route: Exclude<
			CdReadRoute,
			Readonly<{ kind: "openapi" | "ready" | "stream" }>
		>,
	): Promise<Outcome<WireValue>> {
		switch (route.kind) {
			case "pipeline":
				return pipelineView(views, route);
			case "freight":
				return freightTimeline(views, route);
			case "promotions":
				return promotionsView(views, route);
			case "campStatus":
				return campStatusView(views, route);
			case "camps":
				return campsView(views, route);
			case "campInventory":
				return campInventoryView(views, route);
			case "placementDecision":
				return placementDecisionView(views, route);
			case "fanout":
				return fanoutView(views, route);
			case "failovers":
				return failoversView(views, route);
			case "compliance":
				return complianceView(views, route);
		}
	}

	async function route(
		request: FeedRequest,
		signal: AbortSignal,
	): Promise<[FeedResponse, string]> {
		const parsed = parseReadRequest(request);
		if (!parsed.ok) {
			const allow =
				parsed.reasons[0]?.code === "method-not-allowed"
					? { allow: "GET" }
					: {};
			return [refusalResponse(parsed, allow), "refused"];
		}
		if (parsed.value.kind === "feed")
			return [await d.cd.feed.handle(request, signal), "feed"];
		const { route: r } = parsed.value;
		const name = segmentOf(request.path);
		if (r.kind === "openapi") return [rawJsonResponse(cdOpenApi()), name];
		if (r.kind === "ready") return [ready(), name];
		if (r.kind === "stream") {
			const body = cdEventStream({
				store: d.store,
				tenant: d.tenant,
				signal,
				pollMs: d.streamPollMs ?? STREAM_DEFAULTS.pollMs,
				heartbeatMs: d.streamHeartbeatMs ?? STREAM_DEFAULTS.heartbeatMs,
				maxMs: d.streamMaxMs ?? STREAM_DEFAULTS.maxMs,
				batch: d.streamBatch ?? STREAM_DEFAULTS.batch,
				onFrames: (count) =>
					emit([
						{
							name: CD_API_METRICS.streamFrames,
							kind: "counter",
							value: count,
							unit: "1",
							atMs: d.now(),
							attributes: {},
						},
					]),
				after: r.after,
				types: r.types,
			});
			return [sseResponse(body), name];
		}
		try {
			const result = await view(r);
			return [
				result.ok ? okResponse(result.value) : refusalResponse(result),
				name,
			];
		} catch (error) {
			const code = isStoreFailure(error) ? "store-unavailable" : "view-failed";
			return [
				refusalResponse(serviceRefusal(code, messageOf(error), name)),
				name,
			];
		}
	}

	return Object.freeze({
		pathPrefix: "/v1/cd/" as const,
		openapi: cdOpenApi,
		async handle(
			request: FeedRequest,
			signal: AbortSignal,
		): Promise<FeedResponse> {
			const startedAt = performance.now();
			const [response, name] = await route(request, signal);
			emit([
				{
					name: CD_API_METRICS.requests,
					kind: "counter",
					value: 1,
					unit: "1",
					atMs: d.now(),
					attributes: { route: name, status: response.status },
				},
				{
					name: CD_API_METRICS.requestMs,
					kind: "histogram",
					value: performance.now() - startedAt,
					unit: "ms",
					atMs: d.now(),
					attributes: { route: name },
				},
			]);
			return response;
		},
	});
}
