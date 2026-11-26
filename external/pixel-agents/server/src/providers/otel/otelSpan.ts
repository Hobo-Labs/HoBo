/**
 * OTLP/JSON trace parsing + span → AgentEvent translation.
 *
 * Accepts the OTLP/JSON traces export subset:
 *   resourceSpans[] → { resource: { attributes }, scopeSpans[] → { spans[] } }
 * with span fields traceId / spanId / name / kind / status / startTimeUnixNano /
 * endTimeUnixNano. Anything outside the subset is ignored, never an error.
 *
 * Identity mapping (see docs/otel-provider.md):
 *   - resource attr `hobo.camp`      → office Area name
 *   - resource attr `hobo.bindle`    → agent (character) identity
 *   - resource attr `service.name`   → agent identity fallback
 */

import type { AgentEvent } from '../../../../core/src/provider.js';
import {
  OTEL_ATTR_BINDLE,
  OTEL_ATTR_CAMP,
  OTEL_ATTR_SERVICE_NAME,
  OTEL_READING_ATTR_PREFIXES,
  OTEL_SPAN_KIND,
  OTEL_STATUS_CODE_ERROR,
} from './constants.js';

// ── Parsed model ─────────────────────────────────────────────

/** How a span maps onto the existing ToolActivity animation states. */
export type SpanActivity = 'typing' | 'reading';

export interface OtelSpan {
  traceId: string;
  spanId: string;
  name: string;
  /** Agent identity: hobo.bindle when present, else service.name. */
  bindle: string;
  /** Camp (Area) name from hobo.camp, when present. */
  camp?: string;
  /** True when the span record carries an end timestamp (span is complete). */
  hasEnd: boolean;
  /** True when span status.code === STATUS_CODE_ERROR. */
  isError: boolean;
  activity: SpanActivity;
}

// ── Attribute helpers ────────────────────────────────────────

type OtlpAttributeValue = {
  stringValue?: string;
  intValue?: number | string;
  boolValue?: boolean;
  [k: string]: unknown;
};

function attrValueToString(value: OtlpAttributeValue | undefined): string | undefined {
  if (!value) return undefined;
  if (typeof value.stringValue === 'string') return value.stringValue;
  if (typeof value.intValue === 'number') return String(value.intValue);
  if (typeof value.intValue === 'string') return value.intValue;
  if (typeof value.boolValue === 'boolean') return String(value.boolValue);
  return undefined;
}

/** Read OTLP KeyValue[] attributes into a plain string map (drops non-scalars). */
export function readAttributes(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { key, value } = entry as { key?: unknown; value?: OtlpAttributeValue };
    if (typeof key !== 'string') continue;
    const str = attrValueToString(value);
    if (str !== undefined) out[key] = str;
  }
  return out;
}

// ── Classification ───────────────────────────────────────────

/**
 * Classify a span onto the existing ToolActivity states:
 *   - server/client/internal spans        → 'typing'
 *   - producer/consumer (messaging) spans → 'reading'
 *   - spans with db.* / messaging.* attrs → 'reading'
 */
export function classifySpan(
  kind: number | undefined,
  spanAttributes: Record<string, string>,
): SpanActivity {
  if (kind === OTEL_SPAN_KIND.PRODUCER || kind === OTEL_SPAN_KIND.CONSUMER) {
    return 'reading';
  }
  for (const key of Object.keys(spanAttributes)) {
    if (OTEL_READING_ATTR_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      return 'reading';
    }
  }
  return 'typing';
}

// ── Parsing ──────────────────────────────────────────────────

function parseSpan(
  rawSpan: unknown,
  resourceAttrs: Record<string, string>,
): OtelSpan | null {
  if (!rawSpan || typeof rawSpan !== 'object') return null;
  const s = rawSpan as Record<string, unknown>;
  const spanId = typeof s.spanId === 'string' ? s.spanId : '';
  if (!spanId) return null;

  const bindle = resourceAttrs[OTEL_ATTR_BINDLE] ?? resourceAttrs[OTEL_ATTR_SERVICE_NAME];
  if (!bindle) return null;

  const spanAttrs = readAttributes(s.attributes);
  const kind = typeof s.kind === 'number' ? s.kind : undefined;
  const status = s.status as { code?: unknown } | undefined;

  return {
    traceId: typeof s.traceId === 'string' ? s.traceId : '',
    spanId,
    name: typeof s.name === 'string' && s.name ? s.name : 'span',
    bindle,
    camp: resourceAttrs[OTEL_ATTR_CAMP],
    hasEnd: s.endTimeUnixNano !== undefined && s.endTimeUnixNano !== null && s.endTimeUnixNano !== 0 && s.endTimeUnixNano !== '0',
    isError: status?.code === OTEL_STATUS_CODE_ERROR,
    activity: classifySpan(kind, spanAttrs),
  };
}

/**
 * Parse an OTLP/JSON traces body into flat OtelSpan records.
 * Returns [] for anything that doesn't look like a traces export.
 */
export function parseOtlpTraces(body: unknown): OtelSpan[] {
  if (!body || typeof body !== 'object') return [];
  const resourceSpans = (body as Record<string, unknown>).resourceSpans;
  if (!Array.isArray(resourceSpans)) return [];

  const out: OtelSpan[] = [];
  for (const rs of resourceSpans) {
    if (!rs || typeof rs !== 'object') continue;
    const resource = (rs as Record<string, unknown>).resource as
      | { attributes?: unknown }
      | undefined;
    const resourceAttrs = readAttributes(resource?.attributes);
    const scopeSpans = (rs as Record<string, unknown>).scopeSpans;
    if (!Array.isArray(scopeSpans)) continue;
    for (const ss of scopeSpans) {
      if (!ss || typeof ss !== 'object') continue;
      const spans = (ss as Record<string, unknown>).spans;
      if (!Array.isArray(spans)) continue;
      for (const rawSpan of spans) {
        const parsed = parseSpan(rawSpan, resourceAttrs);
        if (parsed) out.push(parsed);
      }
    }
  }
  return out;
}

// ── Span → AgentEvent ────────────────────────────────────────

/** Stable toolId for correlating span start/end through the runtime. */
export function spanToolId(span: OtelSpan): string {
  return `otel-span-${span.spanId}`;
}

/**
 * Translate a span into the canonical AgentEvent model. A span record without
 * an end timestamp is a toolStart; one with an end timestamp is a toolEnd.
 * (A record carrying both start and end yields both events — see
 * spanToAgentEvents — so completed-span exports still animate briefly.)
 */
export function spanToAgentEvent(span: OtelSpan): AgentEvent {
  if (span.hasEnd) {
    return { kind: 'toolEnd', toolId: spanToolId(span) };
  }
  return {
    kind: 'toolStart',
    toolId: spanToolId(span),
    toolName: span.activity === 'reading' ? 'Read' : 'Bash',
    input: { spanName: span.name, traceId: span.traceId, isError: span.isError },
  };
}

/** Both events for a record, in dispatch order. */
export function spanToAgentEvents(span: OtelSpan): AgentEvent[] {
  if (!span.hasEnd) return [spanToAgentEvent(span)];
  return [
    {
      kind: 'toolStart',
      toolId: spanToolId(span),
      toolName: span.activity === 'reading' ? 'Read' : 'Bash',
      input: { spanName: span.name, traceId: span.traceId, isError: span.isError },
    },
    { kind: 'toolEnd', toolId: spanToolId(span) },
  ];
}

/**
 * Display status for a span. The webview derives the character animation from
 * the status prefix (toolUtils.STATUS_TO_TOOL): "Reading …" → Read → reading
 * animation; "Running: …" → Bash → typing animation.
 */
export function formatSpanStatus(span: OtelSpan): string {
  return span.activity === 'reading' ? `Reading ${span.name}` : `Running: ${span.name}`;
}
