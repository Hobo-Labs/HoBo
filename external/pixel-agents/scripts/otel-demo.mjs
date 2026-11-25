#!/usr/bin/env node
/**
 * otel-demo.mjs — drive the pixel-agents office with synthetic OTLP spans.
 *
 * Posts OTLP/JSON trace batches to a running standalone server
 * (`node dist/cli.js --port <port>`). Simulates 3 camps × 3 bindles with a
 * start/stop cadence: each tick some bindles start spans (records without
 * endTimeUnixNano), and spans started on earlier ticks are completed (same
 * spanId, now with endTimeUnixNano). Mixes span kinds (server/client → typing,
 * producer + db.* attrs → reading) and injects an occasional error span
 * (status.code 2 → attention bubble).
 *
 * Usage:
 *   node scripts/otel-demo.mjs [--port 3200] [--ticks 20] [--interval-ms 1200]
 */

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const PORT = Number(argValue('port', '3100'));
const TICKS = Number(argValue('ticks', '20'));
const INTERVAL_MS = Number(argValue('interval-ms', '1200'));
const URL = `http://127.0.0.1:${PORT}/v1/traces`;

const CAMPS = ['payments', 'search', 'platform'];
const BINDLES = {
  payments: ['ledger-api', 'billing-worker', 'fraud-detector'],
  search: ['search-api', 'indexer', 'ranker'],
  platform: ['gateway', 'auth-service', 'queue-consumer'],
};

/** Deterministic pseudo-random per (tick, bindle) so runs look organic but repeat. */
function jitter(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0xffffffff;
}

let spanCounter = 0;
function makeSpan({ camp, bindle, name, kind, attrs = {}, start, end, error }) {
  spanCounter += 1;
  const spanId = `demo${spanCounter.toString(16).padStart(14, '0')}`.slice(-16);
  const attributes = Object.entries(attrs).map(([key, value]) => ({
    key,
    value: { stringValue: String(value) },
  }));
  return {
    resourceAttrs: { 'service.name': bindle, 'hobo.camp': camp },
    span: {
      traceId: `trace${spanId}`,
      spanId,
      name,
      kind,
      startTimeUnixNano: String(start),
      ...(end !== undefined ? { endTimeUnixNano: String(end) } : {}),
      ...(error ? { status: { code: 2, message: 'simulated failure' } } : {}),
      ...(attributes.length ? { attributes } : {}),
    },
  };
}

const SPAN_SHAPES = [
  { name: 'HTTP POST /v1/charge', kind: 2 }, // server → typing
  { name: 'HTTP GET /api/query', kind: 2 },
  { name: 'call downstream', kind: 3 }, // client → typing
  { name: 'SELECT orders', kind: 3, attrs: { 'db.system': 'postgres', 'db.statement': 'select …' } }, // → reading
  { name: 'publish event', kind: 4, attrs: { 'messaging.system': 'kafka' } }, // producer → reading
  { name: 'consume batch', kind: 5, attrs: { 'messaging.system': 'kafka' } }, // consumer → reading
];

async function postSpans(spanRecords) {
  if (spanRecords.length === 0) return;
  // Group spans by resource attributes into OTLP resourceSpans.
  const byResource = new Map();
  for (const { resourceAttrs, span } of spanRecords) {
    const key = JSON.stringify(resourceAttrs);
    if (!byResource.has(key)) byResource.set(key, { resourceAttrs, spans: [] });
    byResource.get(key).spans.push(span);
  }
  const body = {
    resourceSpans: [...byResource.values()].map(({ resourceAttrs, spans }) => ({
      resource: {
        attributes: Object.entries(resourceAttrs).map(([key, value]) => ({
          key,
          value: { stringValue: String(value) },
        })),
      },
      scopeSpans: [{ scope: { name: 'otel-demo' }, spans }],
    })),
  };
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`POST /v1/traces → ${res.status}: ${await res.text()}`);
    process.exitCode = 1;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`OTel demo → ${URL} (${TICKS} ticks, ${INTERVAL_MS}ms interval)`);
  console.log(`Camps: ${CAMPS.join(', ')} — 3 bindles each`);

  /** spanId → completion record to send later */
  const inFlight = new Map();

  for (let tick = 0; tick < TICKS; tick++) {
    const now = Date.now() * 1e6; // ns
    const batch = [];

    // Complete most in-flight spans.
    for (const [spanId, record] of inFlight) {
      if (jitter(`${tick}:${spanId}:end`) < 0.7) {
        batch.push({ ...record, span: { ...record.span, endTimeUnixNano: String(now) } });
        inFlight.delete(spanId);
      }
    }

    // Start new spans: each bindle active ~55% of ticks.
    for (const camp of CAMPS) {
      for (const bindle of BINDLES[camp]) {
        if (jitter(`${tick}:${camp}:${bindle}`) > 0.55) continue;
        const shape = SPAN_SHAPES[Math.floor(jitter(`${bindle}:${tick}:shape`) * SPAN_SHAPES.length)];
        const error = jitter(`${bindle}:${tick}:err`) < 0.06;
        const record = makeSpan({
          camp,
          bindle,
          name: shape.name,
          kind: shape.kind,
          attrs: shape.attrs,
          start: now - Math.floor(jitter(`${bindle}:${tick}:dur`) * 2e8),
          error,
        });
        batch.push(record);
        inFlight.set(record.span.spanId, record);
      }
    }

    await postSpans(batch);
    console.log(
      `tick ${String(tick + 1).padStart(2)}/${TICKS}: sent ${batch.length} span records (${inFlight.size} in flight)`,
    );
    await sleep(INTERVAL_MS);
  }

  // Drain: complete everything still in flight.
  const now = Date.now() * 1e6;
  const drain = [...inFlight.values()].map((record) => ({
    ...record,
    span: { ...record.span, endTimeUnixNano: String(now) },
  }));
  await postSpans(drain);
  console.log(`done — drained ${drain.length} in-flight spans`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
