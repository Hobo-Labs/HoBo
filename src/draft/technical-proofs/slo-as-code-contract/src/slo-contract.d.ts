import { type JsonValue, type JsonObject } from "./json.js";
export interface SloDefinition {
  schema: "hobo.slo/v1";
  apiVersion: "openslo/v1";
  kind: "SLO";
  metadata: {
    name: string;
    labels?: Record<string, string>;
  };
  spec: {
    service: string;
    indicator: RatioIndicator;
    timeWindow: { duration: string; isRolling: boolean };
    budgetingMethod: "Occurrences" | "Timeslices" | "RatioTimeslices";
    objectives: Array<{ displayName: string; target: number }>;
    burnRateThresholds?: BurnRateThreshold[];
  };
}

export interface RatioIndicator {
  ratioMetric: {
    counter: boolean;
    good: TelemetryQuery;
    total: TelemetryQuery;
  };
}

export interface TelemetryQuery {
  telemetry: {
    query: string;
    unit?: string;
  };
}

export interface BurnRateThreshold {
  name: string;
  threshold: number;
  lookbackWindow: string;
  samplingInterval: string;
}

export interface SloEventEnvelope {
  schema: "hobo.telemetry-envelope/v1";
  id: string;
  type: "slo.Declared" | "slo.BudgetBurned" | "slo.BudgetExhausted";
  source: string;
  subject: string;
  streamId: string;
  seq: number;
  time: string;
  meta: {
    traceparent: string;
  };
  data: JsonObject & { schema: "hobo.slo.event/v1"; sloName: string };
}

export interface BudgetView {
  sloName: string;
  gateable: boolean;
  consumedBudgetRatio: number;
  remainingBudgetRatio: number;
  exhausted: boolean;
  lastSeq: number | null;
  lastEventId: string | null;
  reason?: string;
}

export function createGoldenSlo(overrides?: Partial<SloDefinition>): SloDefinition;
export function parseSloDefinition(candidate: JsonValue): {
  ok: boolean;
  errors: string[];
  warnings: string[];
  slo: SloDefinition | null;
};
export function serializeSloDefinition(slo: SloDefinition): string;
export function deserializeSloDefinition(text: string): ReturnType<typeof parseSloDefinition>;
export function validateSloEvent(event: JsonValue): { ok: boolean; errors: string[]; event: SloEventEnvelope | null };
export function serializeSloEvent(event: SloEventEnvelope): string;
export function deserializeSloEvent(text: string): ReturnType<typeof validateSloEvent>;
export function applyBudgetEvent(view: BudgetView, definition: SloDefinition, event: SloEventEnvelope): BudgetView;
export function replayBudgetView(definition: SloDefinition, events: SloEventEnvelope[]): BudgetView;
export function resolveOverlappingSloConflicts(definitions: SloDefinition[]): Array<{
  key: string;
  winner: string;
  candidates: string[];
}>;
