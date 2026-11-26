import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import type { FurnitureAsset } from '../src/assetLoader.js';
import { TILE_FLOOR_1, TILE_WALL } from '../src/providers/otel/constants.js';
import type { OtelProviderDeps } from '../src/providers/otel/otelProvider.js';
import { OtelProvider } from '../src/providers/otel/otelProvider.js';

function kv(key: string, stringValue: string) {
  return { key, value: { stringValue } };
}

function spanBody(
  bindle: string,
  camp: string | undefined,
  spanId: string,
  opts: { end?: boolean; error?: boolean; kind?: number; attrs?: Record<string, string> } = {},
) {
  const resourceAttrs = [kv('service.name', bindle)];
  if (camp) resourceAttrs.push(kv('hobo.camp', camp));
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttrs },
        scopeSpans: [
          {
            spans: [
              {
                traceId: `t-${spanId}`,
                spanId,
                name: `op-${spanId}`,
                kind: opts.kind ?? 2,
                startTimeUnixNano: '1000',
                ...(opts.end ? { endTimeUnixNano: '2000' } : {}),
                ...(opts.error ? { status: { code: 2 } } : {}),
                ...(opts.attrs
                  ? {
                      attributes: Object.entries(opts.attrs).map(([key, value]) =>
                        kv(key, value),
                      ),
                    }
                  : {}),
              },
            ],
          },
        ],
      },
    ],
  };
}

function emptyLayout(cols: number, rows: number) {
  const tiles: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push(
        r === 0 || r === rows - 1 || c === 0 || c === cols - 1 ? TILE_WALL : TILE_FLOOR_1,
      );
    }
  }
  return { version: 1, cols, rows, tiles, furniture: [] as unknown[] };
}

function testCatalog(): FurnitureAsset[] {
  return [
    {
      id: 'DESK_FRONT',
      name: 'Desk',
      label: 'Desk',
      category: 'desks',
      file: 'd.png',
      width: 48,
      height: 32,
      footprintW: 3,
      footprintH: 2,
      isDesk: true,
      canPlaceOnWalls: false,
      orientation: 'front',
    },
    {
      id: 'WOODEN_CHAIR_BACK',
      name: 'Chair',
      label: 'Chair',
      category: 'chairs',
      file: 'c.png',
      width: 16,
      height: 32,
      footprintW: 1,
      footprintH: 2,
      isDesk: false,
      canPlaceOnWalls: false,
      orientation: 'back',
      backgroundTiles: 1,
    },
  ];
}

describe('OtelProvider', () => {
  let store: AgentStateStore;
  let broadcasts: Array<Record<string, unknown>>;
  let layout: Record<string, unknown> | null;
  let writtenLayouts: Array<Record<string, unknown>>;
  let mappings: Record<string, string[]>;
  let stateDir: string;
  let provider: OtelProvider;

  beforeEach(() => {
    store = new AgentStateStore();
    broadcasts = [];
    store.on('broadcast', (msg) => broadcasts.push(msg));
    layout = emptyLayout(24, 24);
    writtenLayouts = [];
    mappings = {};
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-provider-test-'));

    const deps: OtelProviderDeps = {
      store,
      catalog: testCatalog(),
      stateDir,
      readLayout: () => layout,
      writeLayout: (l) => {
        layout = l;
        writtenLayouts.push(l);
      },
      readAreaMappings: () => mappings,
      writeAreaMappings: (m) => {
        mappings = m;
      },
    };
    provider = new OtelProvider(deps);
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('creates one agent per bindle, seated via folderName → camp Area mapping', () => {
    provider.ingest(spanBody('ledger-api', 'payments', 's1'));
    provider.ingest(spanBody('billing-worker', 'payments', 's2'));
    provider.ingest(spanBody('gateway', undefined, 's3'));

    expect(store.size).toBe(3);
    const agents = [...store.values()];
    const ledger = agents.find((a) => a.sessionId === 'otel-ledger-api');
    expect(ledger).toMatchObject({
      providerId: 'otel',
      hooksOnly: true,
      isExternal: true,
      folderName: 'payments',
    });
    // No-camp bindle stays unzoned.
    expect(agents.find((a) => a.sessionId === 'otel-gateway')?.folderName).toBeUndefined();

    // Camp → Area: mapping written, layout materialized with painted tiles.
    expect(mappings['payments']).toEqual(['payments']);
    expect(writtenLayouts.length).toBeGreaterThan(0);
    const finalLayout = layout as { areas?: Array<{ label: string }>; areaTiles?: unknown[] };
    expect(finalLayout.areas?.some((a) => a.label === 'payments')).toBe(true);
    expect(finalLayout.areaTiles?.filter((t) => t === 'payments').length).toBeGreaterThan(0);

    // Two bindles in one camp → two chairs in the area.
    const furniture = (layout as { furniture: Array<{ uid: string }> }).furniture;
    expect(furniture.filter((f) => f.uid.endsWith('-chair'))).toHaveLength(2);
  });

  it('reuses the same agent for subsequent spans of a known bindle', () => {
    provider.ingest(spanBody('ledger-api', 'payments', 's1'));
    provider.ingest(spanBody('ledger-api', 'payments', 's2'));
    expect(store.size).toBe(1);
  });

  it('broadcasts layoutLoaded + areaMappingsLoaded before agentCreated', () => {
    const events: string[] = [];
    store.on('broadcast', (msg) => events.push(`b:${msg.type as string}`));
    store.on('agentAdded', () => events.push('agentAdded'));

    provider.ingest(spanBody('ledger-api', 'payments', 's1'));

    const layoutIdx = events.indexOf('b:layoutLoaded');
    const mappingsIdx = events.indexOf('b:areaMappingsLoaded');
    const addedIdx = events.indexOf('agentAdded');
    expect(mappingsIdx).toBeGreaterThanOrEqual(0);
    expect(layoutIdx).toBeGreaterThan(mappingsIdx);
    expect(addedIdx).toBeGreaterThan(layoutIdx);
  });

  it('drives activity: span start → active + tool start; span end → waiting', () => {
    provider.ingest(spanBody('ledger-api', 'payments', 's1'));
    const agentId = [...store.values()][0].id;

    broadcasts = [];
    provider.ingest(spanBody('ledger-api', 'payments', 's1', { end: true }));

    const types = broadcasts.map((m) => m.type);
    expect(types).toContain('agentToolDone');
    expect(types).toContain('agentToolsClear');
    const status = broadcasts.find((m) => m.type === 'agentStatus' && m.id === agentId);
    expect(status).toMatchObject({ status: 'waiting' });
  });

  it('maps db spans to the reading animation and errors to the attention bubble', () => {
    provider.ingest(
      spanBody('ledger-api', 'payments', 'db1', {
        kind: 3,
        attrs: { 'db.system': 'postgres' },
        error: true,
      }),
    );
    const toolStart = broadcasts.find((m) => m.type === 'agentToolStart');
    expect(toolStart).toMatchObject({ status: 'Reading op-db1', toolName: 'Read' });
    expect(broadcasts.some((m) => m.type === 'agentToolPermission')).toBe(true);

    broadcasts = [];
    provider.ingest(spanBody('ledger-api', 'payments', 'db1', { end: true, error: true }));
    expect(broadcasts.some((m) => m.type === 'agentToolPermissionClear')).toBe(true);
  });

  it('tolerates malformed trace bodies', () => {
    expect(provider.ingest(null).spans).toBe(0);
    expect(provider.ingest({ resourceSpans: 'junk' }).spans).toBe(0);
    expect(store.size).toBe(0);
  });
});
