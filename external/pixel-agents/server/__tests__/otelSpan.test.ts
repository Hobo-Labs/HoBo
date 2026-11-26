import { describe, expect, it } from 'vitest';

import {
  classifySpan,
  formatSpanStatus,
  parseOtlpTraces,
  spanToAgentEvents,
  spanToolId,
} from '../src/providers/otel/otelSpan.js';

function kv(key: string, stringValue: string) {
  return { key, value: { stringValue } };
}

function tracesBody(
  resourceAttrs: Array<{ key: string; value: { stringValue: string } }>,
  spans: Array<Record<string, unknown>>,
) {
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttrs },
        scopeSpans: [{ scope: { name: 'test' }, spans }],
      },
    ],
  };
}

describe('parseOtlpTraces', () => {
  it('parses the OTLP subset and maps service.name → bindle', () => {
    const body = tracesBody(
      [kv('service.name', 'ledger-api'), kv('hobo.camp', 'payments')],
      [
        {
          traceId: 't1',
          spanId: 's1',
          name: 'HTTP POST /charge',
          kind: 2,
          startTimeUnixNano: '1000',
        },
      ],
    );
    const spans = parseOtlpTraces(body);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      bindle: 'ledger-api',
      camp: 'payments',
      name: 'HTTP POST /charge',
      hasEnd: false,
      isError: false,
      activity: 'typing',
    });
  });

  it('prefers hobo.bindle over service.name', () => {
    const body = tracesBody(
      [kv('service.name', 'svc'), kv('hobo.bindle', 'bindle-a')],
      [{ spanId: 's1', name: 'x' }],
    );
    expect(parseOtlpTraces(body)[0].bindle).toBe('bindle-a');
  });

  it('treats endTimeUnixNano as span completion', () => {
    const body = tracesBody(
      [kv('service.name', 'svc')],
      [{ spanId: 's1', name: 'x', endTimeUnixNano: '2000' }],
    );
    expect(parseOtlpTraces(body)[0].hasEnd).toBe(true);
  });

  it('flags error status (code 2)', () => {
    const body = tracesBody(
      [kv('service.name', 'svc')],
      [{ spanId: 's1', name: 'x', status: { code: 2 } }],
    );
    expect(parseOtlpTraces(body)[0].isError).toBe(true);
  });

  it('drops spans without spanId or without any identity attribute', () => {
    const body = tracesBody(
      [kv('service.name', 'svc')],
      [{ name: 'no-id' }, { spanId: 's1', name: 'ok' }],
    );
    expect(parseOtlpTraces(body)).toHaveLength(1);
    const noIdentity = tracesBody([kv('unrelated', 'x')], [{ spanId: 's1', name: 'x' }]);
    expect(parseOtlpTraces(noIdentity)).toHaveLength(0);
  });

  it('returns [] for malformed bodies', () => {
    expect(parseOtlpTraces(null)).toEqual([]);
    expect(parseOtlpTraces({})).toEqual([]);
    expect(parseOtlpTraces('nope')).toEqual([]);
    expect(parseOtlpTraces({ resourceSpans: 'nope' })).toEqual([]);
  });
});

describe('classifySpan', () => {
  it('maps server/client/internal kinds to typing', () => {
    expect(classifySpan(2, {})).toBe('typing');
    expect(classifySpan(3, {})).toBe('typing');
    expect(classifySpan(1, {})).toBe('typing');
    expect(classifySpan(undefined, {})).toBe('typing');
  });

  it('maps producer/consumer (messaging) to reading', () => {
    expect(classifySpan(4, {})).toBe('reading');
    expect(classifySpan(5, {})).toBe('reading');
  });

  it('maps db.* / messaging.* attributes to reading regardless of kind', () => {
    expect(classifySpan(3, { 'db.system': 'postgres' })).toBe('reading');
    expect(classifySpan(2, { 'messaging.destination': 'q' })).toBe('reading');
  });
});

describe('spanToAgentEvents', () => {
  const base = {
    traceId: 't',
    spanId: 'abc',
    name: 'SELECT orders',
    bindle: 'b',
    hasEnd: false,
    isError: false,
    activity: 'reading' as const,
  };

  it('emits toolStart for in-flight spans', () => {
    const events = spanToAgentEvents(base);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'toolStart', toolId: spanToolId(base) });
  });

  it('emits toolStart + toolEnd for completed spans', () => {
    const events = spanToAgentEvents({ ...base, hasEnd: true });
    expect(events.map((e) => e.kind)).toEqual(['toolStart', 'toolEnd']);
  });

  it('status text drives the animation: reading prefix for db spans', () => {
    expect(formatSpanStatus(base)).toBe('Reading SELECT orders');
    expect(formatSpanStatus({ ...base, activity: 'typing' })).toBe('Running: SELECT orders');
  });
});
