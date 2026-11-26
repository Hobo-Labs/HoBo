import type { Trajectory, TrajectoryHash } from "@hobo/core";
import { diagnosticJson, hashTrajectory, parseTrajectory } from "@hobo/core";
import {
	formatTraceparent,
	generateSpanId,
	generateTraceId,
	parseTraceContext,
	TrajectoryCaptureParseError,
} from "./trace-context.js";

// Trajectory capture (IMPL-003 remaining slice): OTel-shaped span records
// with OpenInference semantic-convention attributes around agent actions
// (agent step, tool call, LLM call, eval), assembled into the stored
// Trajectory record @hobo/provider-agentv grades — so capture → grade →
// aggregate → promotion gate closes the loop. Spans leave through a port
// (SpanExporterPort); no network exporter is bundled here — a real
// OTLP/OpenInference exporter is an adapter someone wires later. The
// serialization boundary is the generated Trajectory wire shape
// (core data-models/training_engine.proto): assembly lowers span records to
// proto-JSON and re-ingests them through core's parseTrajectory — parse,
// don't validate, even for spans this module produced itself.

// OpenInference span kinds (Arize OpenInference semantic conventions); the
// wire form is core's generated OpenInferenceSpanKind enum.
const OPENINFERENCE_SPAN_KINDS = [
	"AGENT",
	"CHAIN",
	"EMBEDDING",
	"EVALUATOR",
	"GUARDRAIL",
	"LLM",
	"PROMPT",
	"RERANKER",
	"RETRIEVER",
	"TOOL",
] as const;

export type CapturedSpanKind = (typeof OPENINFERENCE_SPAN_KINDS)[number];

const SPAN_KIND_SET: ReadonlySet<string> = new Set(OPENINFERENCE_SPAN_KINDS);

// public-contract: OpenInference semconv span-kind key — consumers match spans on this exact string.
export const ATTR_OPENINFERENCE_SPAN_KIND = "openinference.span.kind";
// public-contract: OpenInference input value attribute key.
export const ATTR_INPUT_VALUE = "input.value";
// public-contract: OpenInference input mime-type attribute key.
export const ATTR_INPUT_MIME_TYPE = "input.mime_type";
// public-contract: OpenInference output value attribute key.
export const ATTR_OUTPUT_VALUE = "output.value";
// public-contract: OpenInference output mime-type attribute key.
export const ATTR_OUTPUT_MIME_TYPE = "output.mime_type";
// public-contract: OTel status code lowered into attributes (generated OpenInferenceSpan has no status field).
export const ATTR_OTEL_STATUS_CODE = "otel.status_code";
// public-contract: OTel span status message attribute key.
export const ATTR_OTEL_STATUS_MESSAGE = "otel.status_message";
// public-contract: mime type recorded for JSON input/output values.
export const MIME_TYPE_JSON = "application/json";

export type SpanStatusCode = "OK" | "ERROR";

// domain-view: parse-don't-validate span status (OTel status shape); lowered
// into the generated OpenInferenceSpan attribute map on assembly.
export interface SpanStatus {
	readonly code: SpanStatusCode;
	readonly message?: string;
}

// domain-view: OTel-shaped finished span record (traceId/spanId/parentSpanId/
// status) — a deliberately richer parse-don't-validate view whose wire form
// is the generated OpenInferenceSpan (core data-models/training_engine.proto).
export interface CapturedSpan {
	readonly traceId: string;
	readonly spanId: string;
	/** Empty string for a local root span. */
	readonly parentSpanId: string;
	readonly name: string;
	readonly kind: CapturedSpanKind;
	/** ISO-8601 UTC timestamp. */
	readonly startTime: string;
	/** ISO-8601 UTC timestamp, never before startTime. */
	readonly endTime: string;
	readonly attributes: Readonly<Record<string, string>>;
	readonly status: SpanStatus;
}

/** The port finished spans leave through; adapters export them elsewhere. */
export interface SpanExporterPort {
	export(span: CapturedSpan): void;
}

export interface InMemorySpanExporter extends SpanExporterPort {
	readonly spans: readonly CapturedSpan[];
	clear(): void;
}

/** In-memory exporter adapter: collects finished spans (tests, assembly). */
export function createInMemorySpanExporter(): InMemorySpanExporter {
	const spans: CapturedSpan[] = [];
	return {
		get spans(): readonly CapturedSpan[] {
			return [...spans];
		},
		export(span: CapturedSpan): void {
			spans.push(span);
		},
		clear(): void {
			spans.length = 0;
		},
	};
}

export interface SpanIdGenerator {
	traceId(): string;
	spanId(): string;
}

export interface TrajectoryCaptureOptions {
	/** Inbound W3C traceparent to join; omitted = new root trace. */
	readonly traceparent?: string;
	readonly exporter?: SpanExporterPort;
	readonly idGenerator?: SpanIdGenerator;
	/** Injected ISO-8601 clock. */
	readonly now?: () => string;
}

export interface EndSpanOptions {
	readonly output?: unknown;
	readonly status?: SpanStatusCode;
	readonly statusMessage?: string;
	readonly attributes?: Readonly<Record<string, string>>;
}

export interface SpanHandle {
	readonly spanId: string;
	readonly name: string;
	readonly kind: CapturedSpanKind;
	/** W3C traceparent naming this span — propagate it to children/downstream. */
	readonly traceparent: string;
	end(options?: EndSpanOptions): CapturedSpan;
}

export interface StartSpanOptions {
	readonly kind: CapturedSpanKind;
	readonly parent?: SpanHandle;
	readonly input?: unknown;
	readonly attributes?: Readonly<Record<string, string>>;
}

export interface TrajectoryCapture {
	readonly traceId: string;
	/** The trace context of this capture (root parent for new spans). */
	readonly traceparent: string;
	startSpan(name: string, options: StartSpanOptions): SpanHandle;
	openSpanCount(): number;
	finishedSpans(): readonly CapturedSpan[];
	/**
	 * Assembles the finished spans into the stored Trajectory record; throws
	 * a typed error while any span is still open.
	 */
	toTrajectory(options: AssembleTrajectoryOptions): CapturedTrajectory;
}

function fail(path: string, expected: string, received: unknown): never {
	throw new TrajectoryCaptureParseError(
		path,
		expected,
		diagnosticJson(received),
	);
}

function nonEmpty(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		fail(path, "non-empty string", value);
	}
	return value;
}

function isoTimestamp(value: unknown, path: string): string {
	if (typeof value !== "string") fail(path, "ISO-8601 timestamp", value);
	const epochMs = Date.parse(value);
	if (Number.isNaN(epochMs)) fail(path, "ISO-8601 timestamp", value);
	if (epochMs < 0) {
		fail(path, "timestamp at or after the Unix epoch", value);
	}
	return new Date(epochMs).toISOString();
}

const HEX16_PATTERN = /^[0-9a-f]{16}$/;
const HEX32_PATTERN = /^[0-9a-f]{32}$/;

function stringAttributes(
	value: unknown,
	path: string,
): Record<string, string> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		fail(path, "string map", value);
	}
	const attributes: Record<string, string> = {};
	for (const [key, attribute] of Object.entries(value)) {
		if (typeof attribute !== "string") {
			fail(`${path}.${key}`, "string attribute value", attribute);
		}
		attributes[key] = attribute;
	}
	return attributes;
}

/**
 * Parses one finished OTel/OpenInference span record at the ingestion
 * boundary: invalid ids, malformed or pre-epoch timestamps, end-before-start,
 * unfinished spans, and unknown kinds all throw typed errors.
 */
export function parseCapturedSpan(value: unknown): CapturedSpan {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		fail("span", "span record object", value);
	}
	const source = value as Record<string, unknown>;
	const traceId = nonEmpty(source.traceId, "span.traceId");
	if (!HEX32_PATTERN.test(traceId) || traceId === "0".repeat(32)) {
		fail("span.traceId", "32 lowercase hex characters, not all zeroes", {
			received: traceId,
		});
	}
	const spanId = nonEmpty(source.spanId, "span.spanId");
	if (!HEX16_PATTERN.test(spanId) || spanId === "0".repeat(16)) {
		fail("span.spanId", "16 lowercase hex characters, not all zeroes", {
			received: spanId,
		});
	}
	const parentSpanId = source.parentSpanId ?? "";
	if (typeof parentSpanId !== "string") {
		fail("span.parentSpanId", "span id string or empty", parentSpanId);
	}
	if (parentSpanId !== "" && !HEX16_PATTERN.test(parentSpanId)) {
		fail("span.parentSpanId", "16 lowercase hex characters or empty", {
			received: parentSpanId,
		});
	}
	const name = nonEmpty(source.name, "span.name");
	const kind = source.kind;
	if (typeof kind !== "string" || !SPAN_KIND_SET.has(kind)) {
		fail(
			"span.kind",
			`an OpenInference span kind (${OPENINFERENCE_SPAN_KINDS.join(", ")})`,
			kind,
		);
	}
	const startTime = isoTimestamp(source.startTime, "span.startTime");
	if (source.endTime === undefined || source.endTime === "") {
		fail("span.endTime", "a finished span (endTime present)", source.endTime);
	}
	const endTime = isoTimestamp(source.endTime, "span.endTime");
	if (Date.parse(endTime) < Date.parse(startTime)) {
		fail("span.endTime", `at or after startTime (${startTime})`, endTime);
	}
	const attributes = stringAttributes(source.attributes, "span.attributes");
	const statusSource = source.status;
	if (
		!statusSource ||
		typeof statusSource !== "object" ||
		Array.isArray(statusSource)
	) {
		fail("span.status", "span status object", statusSource);
	}
	const code = (statusSource as Record<string, unknown>).code;
	if (code !== "OK" && code !== "ERROR") {
		fail("span.status.code", `"OK" or "ERROR"`, code);
	}
	const message = (statusSource as Record<string, unknown>).message;
	if (message !== undefined && typeof message !== "string") {
		fail("span.status.message", "string", message);
	}
	const status: SpanStatus =
		message === undefined
			? { code }
			: { code, message: nonEmpty(message, "span.status.message") };
	return Object.freeze({
		traceId,
		spanId,
		parentSpanId,
		name,
		kind: kind as CapturedSpanKind,
		startTime,
		endTime,
		attributes: Object.freeze(attributes),
		status: Object.freeze(status),
	});
}

const NOOP_EXPORTER: SpanExporterPort = { export() {} };

const DEFAULT_ID_GENERATOR: SpanIdGenerator = {
	traceId: generateTraceId,
	spanId: generateSpanId,
};

/**
 * Starts a trajectory capture: spans are started/ended around agent actions
 * (AGENT step, TOOL call, LLM call, EVALUATOR run, ...), carry OpenInference
 * semantic-convention attributes, and propagate W3C trace context.
 */
export function createTrajectoryCapture(
	options: TrajectoryCaptureOptions = {},
): TrajectoryCapture {
	const idGenerator = options.idGenerator ?? DEFAULT_ID_GENERATOR;
	const exporter = options.exporter ?? NOOP_EXPORTER;
	const clock = options.now ?? (() => new Date().toISOString());

	const inbound =
		options.traceparent === undefined
			? undefined
			: parseTraceContext(options.traceparent);
	const traceId = inbound?.traceId ?? validTraceId(idGenerator.traceId());
	const flags = inbound?.flags ?? "01";
	// A remote parent is context, not a span of this trajectory: local roots
	// keep parentSpanId "" so the assembled trajectory has a single root.
	const captureTraceparent =
		options.traceparent ??
		formatTraceparent({
			traceId,
			spanId: validSpanId(idGenerator.spanId()),
			flags,
		});

	const openSpans = new Map<
		string,
		{
			readonly name: string;
			readonly kind: CapturedSpanKind;
			readonly parentSpanId: string;
			readonly startTime: string;
			readonly attributes: Record<string, string>;
		}
	>();
	const finished: CapturedSpan[] = [];

	function now(path: string): string {
		return isoTimestamp(clock(), path);
	}

	function validSpanIdUnique(): string {
		const spanId = validSpanId(idGenerator.spanId());
		if (openSpans.has(spanId) || finished.some((s) => s.spanId === spanId)) {
			fail("spanId", "unique span id from the generator", spanId);
		}
		return spanId;
	}

	return {
		traceId,
		traceparent: captureTraceparent,
		startSpan(name: string, startOptions: StartSpanOptions): SpanHandle {
			nonEmpty(name, "span.name");
			if (!SPAN_KIND_SET.has(startOptions.kind)) {
				fail(
					"span.kind",
					`an OpenInference span kind (${OPENINFERENCE_SPAN_KINDS.join(", ")})`,
					startOptions.kind,
				);
			}
			const spanId = validSpanIdUnique();
			const parentSpanId = startOptions.parent?.spanId ?? "";
			if (parentSpanId !== "" && !openSpans.has(parentSpanId)) {
				fail("span.parent", "an open span of this capture", parentSpanId);
			}
			const attributes: Record<string, string> = {
				...stringAttributes(startOptions.attributes, "span.attributes"),
				[ATTR_OPENINFERENCE_SPAN_KIND]: startOptions.kind,
			};
			if (startOptions.input !== undefined) {
				attributes[ATTR_INPUT_VALUE] = JSON.stringify(startOptions.input);
				attributes[ATTR_INPUT_MIME_TYPE] = MIME_TYPE_JSON;
			}
			const startTime = now("span.startTime");
			openSpans.set(spanId, {
				name,
				kind: startOptions.kind,
				parentSpanId,
				startTime,
				attributes,
			});

			return {
				spanId,
				name,
				kind: startOptions.kind,
				traceparent: formatTraceparent({ traceId, spanId, flags }),
				end(endOptions: EndSpanOptions = {}): CapturedSpan {
					const open = openSpans.get(spanId);
					if (!open) {
						fail("span", "an open span (end called once)", spanId);
					}
					const attributesAtEnd: Record<string, string> = {
						...open.attributes,
						...stringAttributes(endOptions.attributes, "span.attributes"),
						[ATTR_OPENINFERENCE_SPAN_KIND]: open.kind,
					};
					if (endOptions.output !== undefined) {
						attributesAtEnd[ATTR_OUTPUT_VALUE] = JSON.stringify(
							endOptions.output,
						);
						attributesAtEnd[ATTR_OUTPUT_MIME_TYPE] = MIME_TYPE_JSON;
					}
					const status: SpanStatus =
						endOptions.statusMessage === undefined
							? { code: endOptions.status ?? "OK" }
							: {
									code: endOptions.status ?? "OK",
									message: endOptions.statusMessage,
								};
					const span = parseCapturedSpan({
						traceId,
						spanId,
						parentSpanId: open.parentSpanId,
						name: open.name,
						kind: open.kind,
						startTime: open.startTime,
						endTime: now("span.endTime"),
						attributes: attributesAtEnd,
						status,
					});
					openSpans.delete(spanId);
					finished.push(span);
					exporter.export(span);
					return span;
				},
			};
		},
		openSpanCount(): number {
			return openSpans.size;
		},
		finishedSpans(): readonly CapturedSpan[] {
			return [...finished];
		},
		toTrajectory(assembleOptions: AssembleTrajectoryOptions) {
			if (openSpans.size > 0) {
				const names = [...openSpans.values()].map((span) => span.name);
				fail("spans", "every span finished before assembly", names);
			}
			return assembleTrajectory(finished, assembleOptions);
		},
	};
}

function validTraceId(traceId: string): string {
	if (!HEX32_PATTERN.test(traceId) || traceId === "0".repeat(32)) {
		fail("traceId", "32 lowercase hex characters, not all zeroes", traceId);
	}
	return traceId;
}

function validSpanId(spanId: string): string {
	if (!HEX16_PATTERN.test(spanId) || spanId === "0".repeat(16)) {
		fail("spanId", "16 lowercase hex characters, not all zeroes", spanId);
	}
	return spanId;
}

export interface AssembleTrajectoryOptions {
	readonly id: string;
	readonly run: {
		readonly id: string;
		readonly tenantId: string;
		readonly bindle: string;
		readonly agent: { readonly id: string; readonly principalRef: string };
	};
	readonly subject: {
		readonly method: string;
		readonly contractRef: string;
		readonly generatedRegion: {
			readonly regionId: string;
			readonly artifactRef: string;
			readonly startOffset: number;
			readonly endOffset: number;
			readonly owner: string;
		};
	};
	/**
	 * The reward slot attached at capture time; live-eval grading
	 * (@hobo/provider-agentv) later computes the authoritative reward.
	 */
	readonly reward: {
		readonly source: string;
		readonly rubricRef: string;
		readonly eventId?: string;
		readonly score?: number;
		readonly observedAt?: string;
	};
	readonly payloads?: Readonly<Record<string, unknown>>;
	/** W3C trace-flags for the assembled traceparent; defaults to "01". */
	readonly flags?: string;
}

export interface CapturedTrajectory {
	/** The parsed generated Trajectory record (core wire shape). */
	readonly trajectory: Trajectory;
	/** The proto-JSON wire form the record round-tripped through. */
	readonly trajectoryJson: Record<string, unknown>;
	/** Canonical provenance hash (core hashTrajectory). */
	readonly hash: TrajectoryHash;
}

/**
 * Assembles finished span records into the stored Trajectory record. Every
 * span is re-parsed at this ingestion boundary; the result round-trips
 * through the generated proto wire shape via core's parseTrajectory.
 */
export function assembleTrajectory(
	spans: readonly unknown[],
	options: AssembleTrajectoryOptions,
): CapturedTrajectory {
	if (!Array.isArray(spans) || spans.length === 0) {
		fail("spans", "at least one finished span", spans);
	}
	const parsed = spans.map((span) => parseCapturedSpan(span));

	const spanIds = new Set<string>();
	for (const span of parsed) {
		if (spanIds.has(span.spanId)) {
			fail("spans", "unique span ids", span.spanId);
		}
		spanIds.add(span.spanId);
	}
	const traceIds = new Set(parsed.map((span) => span.traceId));
	if (traceIds.size > 1) {
		fail("spans", "a single trace id across all spans", [...traceIds]);
	}
	const traceId = parsed[0]?.traceId ?? "";

	const roots = parsed.filter(
		(span) => span.parentSpanId === "" || !spanIds.has(span.parentSpanId),
	);
	if (roots.length !== 1) {
		fail(
			"spans",
			"exactly one root span",
			roots.map((span) => span.spanId),
		);
	}
	const root = roots[0] as CapturedSpan;

	const ordered = [...parsed].sort(
		(left, right) =>
			Date.parse(left.startTime) - Date.parse(right.startTime) ||
			left.spanId.localeCompare(right.spanId),
	);

	const trajectoryJson: Record<string, unknown> = {
		id: nonEmpty(options.id, "trajectory.id"),
		traceparent: formatTraceparent({
			traceId,
			spanId: root.spanId,
			flags: options.flags ?? "01",
		}),
		run: options.run,
		subject: options.subject,
		spans: ordered.map((span) => lowerSpan(span, spanIds)),
		payloads: options.payloads ?? {},
		reward: {
			source: options.reward.source,
			rubricRef: options.reward.rubricRef,
			eventId: options.reward.eventId ?? "",
			score: options.reward.score ?? 0,
			observedAt: options.reward.observedAt ?? "",
		},
	};

	// The serialization boundary: the assembled record must survive the
	// generated proto wire shape and core's CUE-mirrored invariants.
	const trajectory = parseTrajectory(
		JSON.parse(JSON.stringify(trajectoryJson)),
	);
	return Object.freeze({
		trajectory,
		trajectoryJson: deepFreeze(
			JSON.parse(JSON.stringify(trajectoryJson)) as Record<string, unknown>,
		),
		hash: hashTrajectory(trajectory),
	});
}

function lowerSpan(
	span: CapturedSpan,
	spanIds: ReadonlySet<string>,
): Record<string, unknown> {
	const attributes: Record<string, string> = {
		...span.attributes,
		[ATTR_OTEL_STATUS_CODE]: span.status.code,
	};
	if (span.status.message !== undefined) {
		attributes[ATTR_OTEL_STATUS_MESSAGE] = span.status.message;
	}
	return {
		id: span.spanId,
		// A parent outside this trajectory (remote trace context) lowers to "".
		parentId: spanIds.has(span.parentSpanId) ? span.parentSpanId : "",
		kind: `OPEN_INFERENCE_SPAN_KIND_${span.kind}`,
		name: span.name,
		startTime: span.startTime,
		endTime: span.endTime,
		attributes,
		inputsJson: span.attributes[ATTR_INPUT_VALUE] ?? "",
		outputsJson: span.attributes[ATTR_OUTPUT_VALUE] ?? "",
	};
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object") {
		Object.freeze(value);
		for (const nested of Object.values(value)) {
			deepFreeze(nested);
		}
	}
	return value;
}
