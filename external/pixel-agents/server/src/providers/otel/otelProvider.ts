
import * as fs from 'fs';
import * as path from 'path';

import type { StreamProvider } from '../../../../core/src/streamProvider.js';
import type { AgentStateStore } from '../../agentStateStore.js';
import type { FurnitureAsset } from '../../assetLoader.js';
import type { AgentState } from '../../types.js';
import type { OfficeLayoutLike } from './areaPlanner.js';
import { analyzeCampRoom, ensureCampArea, hasOtelFurniture, slugify } from './areaPlanner.js';
import type { OtelSpan } from './otelSpan.js';
import { formatSpanStatus, parseOtlpTraces, spanToAgentEvents } from './otelSpan.js';

export interface OtelProviderDeps {
  store: AgentStateStore;
  catalog: FurnitureAsset[] | null;
  stateDir: string;
  readLayout: () => Record<string, unknown> | null;
  writeLayout: (layout: Record<string, unknown>) => void;
  readAreaMappings: () => Record<string, string[]>;
  writeAreaMappings: (mappings: Record<string, string[]>) => void;
  defaultLayout?: Record<string, unknown> | null;
  setShowAreas?: (enabled: boolean) => void;
}

export interface OtelIngestResult {
  spans: number;
  agentsCreated: number;
  spansStarted: number;
  spansEnded: number;
  camps: string[];
}

interface BindleState {
  agentId: number;
  camp?: string;
  activeSpans: Map<string, { toolId: string; isError: boolean }>;
}

export class OtelProvider implements StreamProvider<unknown, OtelIngestResult> {
  readonly kind = 'stream';
  readonly id = 'otel';
  readonly displayName = 'OpenTelemetry';
  private readonly bindles = new Map<string, BindleState>();
  private showAreasEnabled = false;

  constructor(private readonly deps: OtelProviderDeps) {}

  get agentCount(): number {
    return this.bindles.size;
  }

  validatePersistedAreas(): string[] {
    if (!this.deps.catalog) return [];
    let current = this.deps.readLayout() as OfficeLayoutLike | null;
    if (!current) return [];

    const camps = new Set<string>();
    for (const labels of Object.values(this.deps.readAreaMappings())) {
      for (const label of labels) camps.add(label);
    }

    const rebuilt: string[] = [];
    for (const camp of camps) {
      if (!hasOtelFurniture(current, camp)) continue;
      const status = analyzeCampRoom(current, camp);
      if (status.kind !== 'fragmented' && status.kind !== 'unenclosed') continue;
      const result = ensureCampArea(current, camp, 0, this.deps.catalog, { migrate: true });
      if (result.changed) {
        current = result.layout;
        rebuilt.push(camp);
      }
    }
    if (rebuilt.length > 0) {
      this.deps.writeLayout(current as Record<string, unknown>);
      this.deps.store.broadcast({ type: 'layoutLoaded', layout: current });
      console.log(`[Pixel Agents] OTel: rebuilt fragmented/unenclosed camp rooms: ${rebuilt.join(', ')}`);
    }
    return rebuilt;
  }

  ingest(body: unknown): OtelIngestResult {
    const spans = parseOtlpTraces(body);
    const result: OtelIngestResult = {
      spans: spans.length,
      agentsCreated: 0,
      spansStarted: 0,
      spansEnded: 0,
      camps: [],
    };

    for (const span of spans) {
      const bindle = this.ensureBindle(span.bindle, span.camp, result);
      const events = spanToAgentEvents(span);
      for (const event of events) {
        if (event.kind === 'toolStart') {
          this.handleSpanStart(bindle.agentId, span, event.toolId);
          result.spansStarted += 1;
        } else if (event.kind === 'toolEnd') {
          if (this.handleSpanEnd(bindle.agentId, span, event.toolId)) {
            result.spansEnded += 1;
          }
        }
      }
    }
    return result;
  }


  private ensureBindle(bindleName: string, camp: string | undefined, result: OtelIngestResult): BindleState {
    const existing = this.bindles.get(bindleName);
    if (existing) {
      if (camp && existing.camp !== camp) {
        existing.camp = camp;
        const agent = this.deps.store.get(existing.agentId);
        if (agent) agent.folderName = camp;
        this.materializeCamp(camp);
      }
      return existing;
    }

    if (camp) {
      this.materializeCamp(camp);
      if (!result.camps.includes(camp)) result.camps.push(camp);
    }

    const agentId = this.deps.store.nextAgentId.current++;
    const jsonlFile = this.touchPlaceholder(bindleName);
    const agent: AgentState = {
      id: agentId,
      sessionId: `otel-${slugify(bindleName)}`,
      terminalRef: undefined,
      isExternal: true,
      projectDir: this.deps.stateDir,
      jsonlFile,
      fileOffset: 0,
      lineBuffer: '',
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      backgroundAgentToolIds: new Set(),
      isWaiting: true,
      permissionSent: false,
      hadToolsInTurn: false,
      folderName: camp,
      lastDataAt: Date.now(),
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      hookDelivered: true,
      hooksOnly: true,
      providerId: this.id,
      inputTokens: 0,
      outputTokens: 0,
    };
    this.deps.store.set(agentId, agent);
    this.deps.store.persist();

    const state: BindleState = { agentId, camp, activeSpans: new Map() };
    this.bindles.set(bindleName, state);
    result.agentsCreated += 1;
    console.log(
      `[Pixel Agents] OTel: bindle "${bindleName}" → agent ${agentId}${camp ? ` (camp "${camp}")` : ''}`,
    );
    return state;
  }

  private materializeCamp(camp: string): void {
    let bindleCount = 1;
    for (const b of this.bindles.values()) {
      if (b.camp === camp) bindleCount += 1;
    }

    const current =
      (this.deps.readLayout() as OfficeLayoutLike | null) ??
      (this.deps.defaultLayout as OfficeLayoutLike | null) ??
      null;

    const mappings = { ...this.deps.readAreaMappings() };
    const labels = mappings[camp] ?? [];
    if (!labels.includes(camp)) {
      mappings[camp] = [...labels, camp];
      this.deps.writeAreaMappings(mappings);
    }
    this.deps.store.broadcast({ type: 'areaMappingsLoaded', mappings });

    if (!this.showAreasEnabled) {
      this.showAreasEnabled = true;
      this.deps.setShowAreas?.(true);
    }

    if (current && this.deps.catalog) {
      const { layout, changed } = ensureCampArea(current, camp, bindleCount, this.deps.catalog, {
        migrate: true,
      });
      if (changed) {
        this.deps.writeLayout(layout as Record<string, unknown>);
        this.deps.store.broadcast({ type: 'layoutLoaded', layout });
      }
    }
  }

  private touchPlaceholder(bindleName: string): string {
    const file = path.join(this.deps.stateDir, `${slugify(bindleName)}.jsonl`);
    try {
      fs.mkdirSync(this.deps.stateDir, { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, '');
    } catch (err) {
      console.error('[Pixel Agents] OTel: failed to create placeholder file:', err);
    }
    return file;
  }


  private handleSpanStart(agentId: number, span: OtelSpan, toolId: string): void {
    const bindle = this.bindles.get(span.bindle);
    if (!bindle) return;
    if (bindle.activeSpans.has(span.spanId)) return;
    bindle.activeSpans.set(span.spanId, { toolId, isError: span.isError });

    this.deps.store.broadcast({
      type: 'agentToolStart',
      id: agentId,
      toolId,
      status: formatSpanStatus(span),
      toolName: span.activity === 'reading' ? 'Read' : 'Bash',
    });
    this.deps.store.broadcast({ type: 'agentStatus', id: agentId, status: 'active' });
    if (span.isError) {
      this.deps.store.broadcast({ type: 'agentToolPermission', id: agentId });
    }
  }

  private handleSpanEnd(agentId: number, span: OtelSpan, toolId: string): boolean {
    const bindle = this.bindles.get(span.bindle);
    if (!bindle) return false;
    const tracked = bindle.activeSpans.get(span.spanId);
    bindle.activeSpans.delete(span.spanId);

    this.deps.store.broadcast({ type: 'agentToolDone', id: agentId, toolId });
    if (tracked?.isError || span.isError) {
      this.deps.store.broadcast({ type: 'agentToolPermissionClear', id: agentId });
    }
    if (bindle.activeSpans.size === 0) {
      this.deps.store.broadcast({ type: 'agentToolsClear', id: agentId });
      this.deps.store.broadcast({ type: 'agentStatus', id: agentId, status: 'waiting' });
    }
    return true;
  }
}
