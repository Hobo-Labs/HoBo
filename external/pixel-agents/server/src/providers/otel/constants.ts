/**
 * Constants for the OpenTelemetry (OTLP) provider.
 *
 * The OTel provider is a push-based provider (no hook scripts, no transcripts):
 * OTLP/JSON trace exports arrive at POST /v1/traces and are translated into the
 * canonical AgentEvent model plus direct store broadcasts.
 */

/** Resource attribute naming a HoBo camp. A camp becomes an office Area. */
export const OTEL_ATTR_CAMP = 'hobo.camp';
/** Resource attribute naming a HoBo bindle. Overrides service.name as agent identity. */
export const OTEL_ATTR_BINDLE = 'hobo.bindle';
/** Standard OTel resource attribute used as agent identity fallback. */
export const OTEL_ATTR_SERVICE_NAME = 'service.name';

/** Span attribute prefixes that classify a span as "reading" (db/messaging work)
 *  instead of "typing". */
export const OTEL_READING_ATTR_PREFIXES = ['db.', 'messaging.'];

/** OTel span kind values (otlp trace.v1 Span.SpanKind). */
export const OTEL_SPAN_KIND = {
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
  PRODUCER: 4,
  CONSUMER: 5,
} as const;

/** OTel status code for error spans (otlp trace.v1 Status.StatusCode). */
export const OTEL_STATUS_CODE_ERROR = 2;

// ── Layout constants ──
// Mirrored from webview-ui/src/constants.ts and webview-ui/src/office/types.ts.
// server/ cannot import webview-ui/ (layering: server depends only on core/),
// so the values needed by the area planner are duplicated here. Keep in sync.
export const TILE_WALL = 0;
export const TILE_FLOOR_1 = 1;
export const TILE_VOID = 255;
export const MAX_COLS = 64;
export const MAX_ROWS = 64;

/** Workstation cell: desk (3x2) + chair (1x2) + gaps. One seat per cell. */
export const WORKSTATION_CELL_W = 4;
export const WORKSTATION_CELL_H = 5;

/** Grid growth step when no free region fits a workstation. */
export const GRID_GROW_ROWS = WORKSTATION_CELL_H + 1;
export const GRID_GROW_COLS = WORKSTATION_CELL_W + 1;

/** Floor color for tiles added by grid growth (warm beige, matches the
 *  webview's DEFAULT_LEFT_ROOM_COLOR in layoutSerializer.ts). */
export const GROWN_TILE_COLOR = { h: 35, s: 30, b: 15, c: 0 };
