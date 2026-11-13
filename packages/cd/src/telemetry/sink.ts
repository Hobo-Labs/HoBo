// `createTelemetrySink` (WP19, D17): an OTLP/HTTP JSON exporter over the core
// `HttpTransport` port — no OpenTelemetry SDK dependency. Each call exports
// its spans or points in batches of at most `maxBatch`, retrying retryable
// failures (429, 502, 503, 504, transport errors) with capped exponential
// backoff that honours `Retry-After`, per the OTLP/HTTP specification.
// Backoff has no jitter so tests and replays are deterministic.
import type { HttpTransport, JsonValue, TransportResponse } from "@hobo/core";
import {
	isFiniteNumber,
	isJsonObject,
	isText,
	parseJsonText,
} from "../authz/json.js";
import type {
	OtelAttributes,
	OtelMetricPoint,
	OtelSpan,
	TelemetrySink,
} from "../ports.js";
import { TelemetryError } from "./errors.js";
import { encodeMetrics, encodeTraces } from "./otlp.js";

// public-contract: OTLP/HTTP defaults (opentelemetry-specification, exporter).
export const OTLP_DEFAULTS = Object.freeze({
	endpoint: "http://localhost:4318",
	tracesPath: "/v1/traces",
	metricsPath: "/v1/metrics",
	timeoutMs: 10_000,
	maxBatch: 512,
	maxAttempts: 5,
	backoffBaseMs: 1_000,
	backoffMaxMs: 30_000,
	maxResponseBytes: 1_048_576,
} as const);

const RETRYABLE: ReadonlySet<number> = new Set([429, 502, 503, 504]);

export type TelemetrySinkOptions = Readonly<{
	endpoint?: string;
	http: HttpTransport;
	headers?: Readonly<Record<string, string>>;
	/** OTLP resource attributes; default `service.name=hobo-cd`. */
	resource?: OtelAttributes;
	maxBatch?: number;
	maxAttempts?: number;
	backoffBaseMs?: number;
	backoffMaxMs?: number;
	timeoutMs?: number;
	sleep?: (ms: number) => Promise<void>;
}>;

export type ExportStats = Readonly<{
	requests: number;
	retries: number;
	exportedSpans: number;
	exportedPoints: number;
	droppedSpans: number;
	droppedPoints: number;
	lastError?: Readonly<{ code: string; message: string }>;
}>;

type MutableStats = {
	requests: number;
	retries: number;
	exportedSpans: number;
	exportedPoints: number;
	droppedSpans: number;
	droppedPoints: number;
	lastError: Readonly<{ code: string; message: string }> | undefined;
};

export type OtlpTelemetrySink = TelemetrySink &
	Readonly<{ endpoint: string; stats(): ExportStats }>;

/** Parse the endpoint once; an invalid one is a construction-time error. */
export function parseOtlpEndpoint(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new TelemetryError(
			"otlp-endpoint-invalid",
			`OTLP endpoint is not a URL: ${raw}`,
		);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new TelemetryError(
			"otlp-endpoint-invalid",
			`OTLP endpoint must be http(s): ${url.protocol}`,
		);
	if (url.search !== "" || url.hash !== "" || url.username !== "")
		throw new TelemetryError(
			"otlp-endpoint-invalid",
			"OTLP endpoint must carry no query, fragment or credentials",
		);
	return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}

function positive(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isSafeInteger(value) && value > 0
		? value
		: fallback;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size)
		out.push(items.slice(i, i + size));
	return out;
}

function retryAfterMs(response: TransportResponse): number | undefined {
	const header = Object.entries(response.headers).find(
		([key]) => key.toLowerCase() === "retry-after",
	)?.[1];
	if (header === undefined) return undefined;
	const seconds = Number(header);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

/** The OTLP `partialSuccess` member of an export response, parsed. */
type PartialSuccess = Readonly<{ rejected: number; message: string }>;

const NO_PARTIAL: PartialSuccess = { rejected: 0, message: "" };

/** OTLP JSON encodes int64 counts as strings or numbers. */
function count(value: JsonValue | undefined): number {
	const n = isText(value) ? Number(value) : isFiniteNumber(value) ? value : 0;
	return Number.isFinite(n) && n > 0 ? n : 0;
}

function parsePartialSuccess(body: string): PartialSuccess {
	const parsed = parseJsonText(body);
	if (!isJsonObject(parsed)) return NO_PARTIAL;
	const partial = parsed.partialSuccess;
	if (!isJsonObject(partial)) return NO_PARTIAL;
	const message = partial.errorMessage;
	return {
		rejected: count(partial.rejectedSpans) + count(partial.rejectedDataPoints),
		message: isText(message) ? message : "",
	};
}

export function createTelemetrySink(
	options: TelemetrySinkOptions,
): OtlpTelemetrySink {
	const endpoint = parseOtlpEndpoint(
		options.endpoint ?? OTLP_DEFAULTS.endpoint,
	);
	const maxBatch = positive(options.maxBatch, OTLP_DEFAULTS.maxBatch);
	const maxAttempts = positive(options.maxAttempts, OTLP_DEFAULTS.maxAttempts);
	const base = positive(options.backoffBaseMs, OTLP_DEFAULTS.backoffBaseMs);
	const cap = positive(options.backoffMaxMs, OTLP_DEFAULTS.backoffMaxMs);
	const timeoutMs = positive(options.timeoutMs, OTLP_DEFAULTS.timeoutMs);
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const resourceAttributes: OtelAttributes = options.resource ?? {
		"service.name": "hobo-cd",
	};
	const headers = {
		...options.headers,
		"Content-Type": "application/json",
	};
	const stats: MutableStats = {
		requests: 0,
		retries: 0,
		exportedSpans: 0,
		exportedPoints: 0,
		droppedSpans: 0,
		droppedPoints: 0,
		lastError: undefined,
	};

	async function post(path: string, body: string): Promise<void> {
		for (let attempt = 1; ; attempt += 1) {
			stats.requests += 1;
			let response: TransportResponse | undefined;
			let failure = "";
			try {
				response = await options.http({
					method: "POST",
					url: `${endpoint}${path}`,
					headers,
					body,
					timeoutMs,
					maxResponseBytes: OTLP_DEFAULTS.maxResponseBytes,
				});
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			}
			if (response && response.status >= 200 && response.status < 300) {
				const partial = parsePartialSuccess(response.body);
				if (partial.rejected > 0)
					throw new TelemetryError(
						"otlp-partial-success",
						`collector rejected ${partial.rejected} item(s): ${partial.message}`,
						response.status,
					);
				return;
			}
			if (response && !RETRYABLE.has(response.status))
				throw new TelemetryError(
					"otlp-rejected",
					`collector answered ${response.status} for ${path}`,
					response.status,
				);
			if (attempt >= maxAttempts)
				throw new TelemetryError(
					"otlp-retries-exhausted",
					`${path} failed after ${attempt} attempt(s): ${response ? `status ${response.status}` : failure}`,
					response?.status,
				);
			const backoff = Math.min(cap, base * 2 ** (attempt - 1));
			const hinted = response ? retryAfterMs(response) : undefined;
			stats.retries += 1;
			await sleep(hinted === undefined ? backoff : Math.min(cap, hinted));
		}
	}

	async function exportAll<T, B extends object>(
		items: readonly T[],
		encode: (batch: readonly T[]) => B,
		path: string,
		onSent: (n: number) => void,
		onDropped: (n: number) => void,
	): Promise<void> {
		let firstError: TelemetryError | undefined;
		for (const batch of chunks(items, maxBatch)) {
			try {
				await post(path, JSON.stringify(encode(batch)));
				onSent(batch.length);
			} catch (error) {
				const typed =
					error instanceof TelemetryError
						? error
						: new TelemetryError("otlp-retries-exhausted", String(error));
				if (typed.code === "otlp-partial-success") onSent(batch.length);
				else onDropped(batch.length);
				stats.lastError = { code: typed.code, message: typed.message };
				firstError ??= typed;
			}
		}
		if (firstError) throw firstError;
	}

	return {
		endpoint,
		async spans(spans: readonly OtelSpan[]) {
			await exportAll(
				spans,
				(batch) => encodeTraces(batch, resourceAttributes),
				OTLP_DEFAULTS.tracesPath,
				(n) => {
					stats.exportedSpans += n;
				},
				(n) => {
					stats.droppedSpans += n;
				},
			);
		},
		async metrics(points: readonly OtelMetricPoint[]) {
			await exportAll(
				points,
				(batch) => encodeMetrics(batch, resourceAttributes),
				OTLP_DEFAULTS.metricsPath,
				(n) => {
					stats.exportedPoints += n;
				},
				(n) => {
					stats.droppedPoints += n;
				},
			);
		},
		stats() {
			const { lastError, ...counts } = stats;
			return lastError === undefined ? { ...counts } : { ...counts, lastError };
		},
	};
}
