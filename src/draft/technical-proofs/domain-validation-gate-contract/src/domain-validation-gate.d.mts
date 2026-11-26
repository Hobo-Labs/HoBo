import { type JsonValue, type JsonObject } from "./json.js";
export type CheckKind =
  | "multi-vantage-resolve"
  | "ttl-aware-propagation"
  | "acme-challenge"
  | "endpoint-health";

export type DomainValidationEventType =
  | "domain.ValidationStarted"
  | "domain.Validated"
  | "domain.ValidationFailed";

export interface ValidationCheckResult {
  ok: boolean;
  reason?: string;
  evidence?: JsonObject;
}

export interface ValidationCheckEvidence {
  kind: CheckKind;
  status: "passed";
  evidence: JsonObject;
}

export interface DomainValidationEvent {
  type: DomainValidationEventType;
  data: JsonObject;
}

export interface DomainValidationRequest {
  domain: string;
  changeId: string;
  camp: string;
  stage(): Promise<JsonValue>;
  liveZone?: {
    assertUnchanged(label: string): void;
  };
}

export interface DomainValidationGate {
  validate(request: DomainValidationRequest): Promise<{
    status: "validated" | "failed";
    events: DomainValidationEvent[];
    checks: ValidationCheckEvidence[];
    failedCheck?: CheckKind | "shadow-stage" | "live-zone-invariant";
    reason?: string;
  }>;
}

export declare const REQUIRED_CHECK_KINDS: readonly CheckKind[];

export declare function createDomainValidationGate(options: {
  checks: Record<
    CheckKind,
    (request: DomainValidationRequest) => Promise<ValidationCheckResult> | ValidationCheckResult
  >;
  timeoutMs?: number;
  clock?: () => string;
}): DomainValidationGate;

export declare function domainValidationChecks(fixtures: JsonObject): Record<CheckKind, () => ValidationCheckResult>;

export declare function createLiveZoneSnapshot(adapter: {
  inspectLiveZone(domain: string): JsonValue[];
}, domain: string): {
  assertUnchanged(label: string): void;
};

export declare function assertValidationEventSequence(events: DomainValidationEvent[]): true;
