/**
 * OpenTelemetry provider: drives office characters from OTLP trace spans.
 *
 * This is the first push-based provider (see core/src/provider.ts — provider
 * types beyond HookProvider were deferred until a real one shipped). It does
 * NOT implement HookProvider: there are no hook scripts to install and no
 * transcripts to poll. Instead, POST /v1/traces delivers OTLP/JSON exports,
 * spans are translated into the canonical AgentEvent model (otelSpan.ts), and
 * this class applies them directly to the AgentStateStore with the same
 * broadcast messages the hook path emits (agentToolStart / agentToolDone /
 * agentToolsClear / agentStatus / agentToolPermission).
 *
 * Mappings (docs/otel-provider.md):
 *   - camp   (resource attr hobo.camp)   → office Area (auto-materialized)
 *   - bindle (hobo.bindle / service.name) → one agent character, seated in
 *     its camp's Area via the standard folderName → areaMappings seating.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { AgentStateStore } from '../../agentStateStore.js';
import type { FurnitureAsset } from '../../assetLoader.js';
import type { AgentState } from '../../types.js';
import type { OfficeLayoutLike } from './areaPlanner.js';
import { analyzeCampRoom, ensureCampArea, hasOtelFurniture, slugify } from './areaPlanner.js';
import type { OtelSpan } from './otelSpan.js';
import { formatSpanStatus, parseOtlpTraces, spanToAgentEvents } from './otelSpan.js';

/** Persistence seams injected by the CLI so this class stays unit-testable. */
export interface OtelProviderDeps {
  store: AgentStateStore;
  /** Furniture catalog (for desk/chair footprints). Null → area paint only. */
  catalog: FurnitureAsset[] | null;
  /** Directory for synthetic per-bindle transcript placeholders. */
  stateDir: string;
  readLayout: () => Record<string, unknown> | null;
  writeLayout: (layout: Record<string, unknown>) => void;
  readAreaMappings: () => Record<string, string[]>;
  writeAreaMappings: (mappings: Record<string, string[]>) => void;
  /** Bundled default layout, used when no layout file exists yet. */
  defaultLayout?: Record<string, unknown> | null;
  /** Called once when the first camp area is materialized (CLI wires this to
   *  persist `pixel-agents.showAreas` so camp zones render tinted). */
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
  /** spanId → { toolId } for spans currently animating. */
  activeSpans: Map<string, { toolId: string; isError: boolean }>;
}

export class OtelProvider {
  readonly id = 'otel';
  readonly displayName = 'OpenTelemetry';
  private readonly bindles = new Map<string, BindleState>();
  private showAreasEnabled = false;

  constructor(private readonly deps: OtelProviderDeps) {}

  /** Number of bindle agents currently known (for diagnostics). */
  get agentCount(): number {
    return this.bindles.size;
  }

  /**
   * Boot-time migration: rebuild any auto-materialized camp room that is
   * fragmented (same label in disjoint regions) or unenclosed (no wall ring).
   * Only camps with OTel-placed furniture are touched — hand-painted user
   * areas without our marker are left alone even when they look "invalid".
   * Returns the camp labels that were rebuilt.
   */
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

  /**
   * Ingest one OTLP/JSON traces body. Never throws on malformed input —
   * unparseable bodies simply yield zero spans.
   */
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

  // ── Bindle → agent ─────────────────────────────────────────

  private ensureBindle(bindleName: string, camp: string | undefined, result: OtelIngestResult): BindleState {
    const existing = this.bindles.get(bindleName);
    if (existing) {
      // Late-arriving camp attribution: update mapping so future restarts and
      // rebuilds seat the character in its camp's Area.
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
      hookDelivered: true, // suppress heuristic timers — all state comes from spans
      hooksOnly: true,
      providerId: this.id,
      inputTokens: 0,
      outputTokens: 0,
    };
    // store.set fires agentAdded → httpServer broadcasts agentCreated (with
    // folderName) → webview seats the character in the camp's Area.
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

  /**
   * Camp → Area: materialize the Area (definition + painted tiles + one
   * workstation per bindle in the camp), point the folder mapping at it, and
   * broadcast the updates so connected webviews rebuild before the character
   * is created.
   */
  private materializeCamp(camp: string): void {
    // Count bindles already attributed to this camp (+1 for the new one).
    let bindleCount = 1;
    for (const b of this.bindles.values()) {
      if (b.camp === camp) bindleCount += 1;
    }

    const current =
      (this.deps.readLayout() as OfficeLayoutLike | null) ??
      (this.deps.defaultLayout as OfficeLayoutLike | null) ??
      null;

    // Mappings first, then layoutLoaded: the rebuild triggered by layoutLoaded
    // reseats characters using the folder→Area mappings, so they must already
    // be in place when it arrives.
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

  /**
   * The runtime's external-agent tracking keys on transcript files. OTel
   * bindles have none, so each gets an empty placeholder file: it keeps the
   * stale-check (which removes external agents whose file vanished) and the
   * restore path (which skips missing files) from ever touching span-driven
   * agents.
   */
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

  // ── Span activity → agent activity ─────────────────────────

  private handleSpanStart(agentId: number, span: OtelSpan, toolId: string): void {
    const bindle = this.bindles.get(span.bindle);
    if (!bindle) return;
    if (bindle.activeSpans.has(span.spanId)) return; // duplicate start
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
      // Error status → the office's attention state (permission bubble).
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
      // No active spans → turn over: clear tools, character goes idle/waiting.
      this.deps.store.broadcast({ type: 'agentToolsClear', id: agentId });
      this.deps.store.broadcast({ type: 'agentStatus', id: agentId, status: 'waiting' });
    }
    return true;
  }
}
