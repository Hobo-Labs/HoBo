import { type JsonValue, type JsonObject } from "./json.js";
export const IDENTITY_EVENT_SCHEMA_VERSION: "hobo.identity-events/v1";
export const IDENTITY_EVENT_TYPES: readonly string[];
export const CREDENTIAL_AUDIT_RETENTION: {
  readonly class: "security-audit";
  readonly neverCompact: true;
  readonly streamPolicy: string;
};

export interface PrincipalRef {
  kind: "user" | "agent" | "service";
  id: string;
  delegatedBy?: PrincipalRef;
}

export interface IdentityEvent {
  id: string;
  type: string;
  schemaVersion: typeof IDENTITY_EVENT_SCHEMA_VERSION;
  tenant: string;
  seq: number;
  time: string;
  actor: PrincipalRef;
  correlationId: string;
  causationId: string;
  retention: typeof CREDENTIAL_AUDIT_RETENTION;
  data: JsonObject;
}

export function createIdentityEvent(
  type: string,
  data: JsonObject,
  overrides?: Partial<IdentityEvent>,
): IdentityEvent;
export function createFixtureEventForType(type: string): IdentityEvent;
export function validateIdentityEvent(event: JsonValue): { ok: boolean; errors: string[] };
export function roundTripIdentityEvent(event: IdentityEvent): IdentityEvent;
export function foldCredentialAudit(events: IdentityEvent[]): {
  chains: Array<{
    user?: string;
    agent?: string;
    target: string;
    audience: string;
    scopes: string[];
    grants: string[];
    uses: string[];
    secretRefs: string[];
    revoked: boolean;
  }>;
  grantsById: Record<string, IdentityEvent>;
  revokedGrantIds: string[];
  anomalies: Array<JsonObject>;
};
