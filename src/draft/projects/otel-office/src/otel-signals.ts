import type { AgentEvent, OfficeState } from "./model.js";
import { attributesToRecord, ensureCharacter } from "./otel.js";
import { isJsonString } from "./json.js";

interface OtlpValue {
	stringValue?: string;
	intValue?: number | string;
	doubleValue?: number;
}

interface OtlpAttribute {
	key: string;
	value: OtlpValue;
}

interface OtlpLogRecord {
	timeUnixNano?: string | number;
	severityNumber?: number;
	severityText?: string;
	body?: OtlpValue;
	attributes?: OtlpAttribute[];
	traceId?: string;
}

interface OtlpScopeLogs {
	scope?: { name?: string };
	logRecords?: OtlpLogRecord[];
}

export interface OtlpLogsRequest {
	resourceLogs?: {
		resource?: { attributes?: OtlpAttribute[] };
		scopeLogs?: OtlpScopeLogs[];
	}[];
}

interface OtlpDataPoint {
	timeUnixNano?: string | number;
	asDouble?: number;
	asInt?: number | string;
	attributes?: OtlpAttribute[];
}

interface OtlpMetric {
	name: string;
	sum?: { dataPoints?: OtlpDataPoint[] };
	gauge?: { dataPoints?: OtlpDataPoint[] };
}

export interface OtlpMetricsRequest {
	resourceMetrics?: {
		resource?: { attributes?: OtlpAttribute[] };
		scopeMetrics?: { scope?: { name?: string }; metrics?: OtlpMetric[] }[];
	}[];
}

function nanoToMs(value: string | number | undefined): number {
	if (value === undefined) return 0;
	const n = isJsonString(value) ? Number(value) : value;
	return Math.floor(n / 1_000_000);
}

type Severity = "INFO" | "WARN" | "ERROR";

export function severityFromOtlp(
	severityNumber: number | undefined,
	severityText: string | undefined,
): Severity {
	if (severityNumber !== undefined) {
		if (severityNumber >= 17) return "ERROR";
		if (severityNumber >= 13) return "WARN";
		return "INFO";
	}
	const text = severityText?.toUpperCase() ?? "";
	if (text.startsWith("ERROR") || text.startsWith("FATAL")) return "ERROR";
	if (text.startsWith("WARN")) return "WARN";
	return "INFO";
}

const BUBBLE_MAX = 120;

function bodyToText(body: OtlpValue | undefined): string {
	const raw = body?.stringValue ?? body?.doubleValue ?? body?.intValue ?? "";
	const text = String(raw);
	return text.length > BUBBLE_MAX ? `${text.slice(0, BUBBLE_MAX - 1)}…` : text;
}

export function mapLogsPayload(
	payload: OtlpLogsRequest,
	state: OfficeState,
	now = Date.now(),
): AgentEvent[] {
	const events: AgentEvent[] = [];
	for (const rl of payload.resourceLogs ?? []) {
		const resourceAttrs = attributesToRecord(rl.resource?.attributes);
		const character = ensureCharacter(state, resourceAttrs, now);
		for (const sl of rl.scopeLogs ?? []) {
			for (const record of sl.logRecords ?? []) {
				const severity = severityFromOtlp(record.severityNumber, record.severityText);
				const message = bodyToText(record.body);
				if (message === "") continue;
				events.push({
					type: "log-record",
					at: nanoToMs(record.timeUnixNano) || now,
					characterId: character.id,
					severity,
					message,
					...(record.traceId !== undefined ? { traceId: record.traceId } : undefined),
				});
			}
		}
	}
	return events;
}

interface MetricHealthMap {
	"hobo.health": (value: number) => number;
	"hobo.error.rate": (value: number) => number;
}

export const METRIC_HEALTH_MAP: MetricHealthMap = {
	"hobo.health": (value) => value,
	"hobo.error.rate": (value) => 1 - value,
};

export function mapMetricsPayload(
	payload: OtlpMetricsRequest,
	state: OfficeState,
	now = Date.now(),
): AgentEvent[] {
	const events: AgentEvent[] = [];
	for (const rm of payload.resourceMetrics ?? []) {
		const resourceAttrs = attributesToRecord(rm.resource?.attributes);
		const character = ensureCharacter(state, resourceAttrs, now);
		for (const sm of rm.scopeMetrics ?? []) {
			for (const metric of sm.metrics ?? []) {
				const healthMap = Object.hasOwn(METRIC_HEALTH_MAP, metric.name)
					? METRIC_HEALTH_MAP[metric.name as keyof MetricHealthMap]
					: undefined;
				const points = [...(metric.sum?.dataPoints ?? []), ...(metric.gauge?.dataPoints ?? [])];
				for (const point of points) {
					const raw = point.asDouble ?? Number(point.asInt ?? 0);
					if (Number.isNaN(raw)) continue;
					events.push({
						type: "metric-sample",
						at: nanoToMs(point.timeUnixNano) || now,
						characterId: character.id,
						metric: healthMap === undefined ? metric.name : "health",
						value: healthMap === undefined ? raw : Math.max(0, Math.min(1, healthMap(raw))),
					});
				}
			}
		}
	}
	return events;
}
