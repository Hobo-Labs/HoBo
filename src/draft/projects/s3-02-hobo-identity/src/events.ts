import { asJsonObject, type JsonObject } from "./json.js";
export const IDENTITY_EVENT_SCHEMA_VERSION = "hobo.identity-events/v1";

export const CREDENTIAL_AUDIT_RETENTION = Object.freeze({
  class: "security-audit",
  neverCompact: true,
  streamPolicy: "retain-token-identity-session-audit",
});

export type IdentityEvent = Readonly<{
  id: string;
  type: "identity.Issued" | "identity.Rotated";
  schemaVersion: typeof IDENTITY_EVENT_SCHEMA_VERSION;
  tenant: string;
  seq: number;
  time: string;
  actor: Readonly<{ kind: string; id: string }>;
  correlationId: string;
  causationId: string;
  retention: typeof CREDENTIAL_AUDIT_RETENTION;
  data: Readonly<JsonObject>;
}>;

export function createIdentityIssuedEvent(input: {
  identityId: string;
  subject: string;
  svidRef: string;
  scope: readonly Readonly<{ port: string; resource: string; verbs: readonly string[] }>[];
  expiresAt: string;
  tenant: string;
  seq?: number;
  time?: string;
}): IdentityEvent {
  return {
    id: `evt-identity-issued-${input.identityId}`,
    type: "identity.Issued",
    schemaVersion: IDENTITY_EVENT_SCHEMA_VERSION,
    tenant: input.tenant,
    seq: input.seq ?? 0,
    time: input.time ?? new Date().toISOString(),
    actor: { kind: "service", id: "yard/identity" },
    correlationId: `corr-${input.identityId}`,
    causationId: `cmd-issue-${input.identityId}`,
    retention: CREDENTIAL_AUDIT_RETENTION,
    data: asJsonObject({
      identityId: input.identityId,
      subject: input.subject,
      svidRef: input.svidRef,
      scope: input.scope,
      expiresAt: input.expiresAt,
    }),
  };
}

export function createIdentityRotatedEvent(input: {
  identityId: string;
  previousIdentityId: string;
  subject: string;
  svidRef: string;
  expiresAt: string;
  tenant: string;
  seq?: number;
  time?: string;
}): IdentityEvent {
  return {
    id: `evt-identity-rotated-${input.identityId}`,
    type: "identity.Rotated",
    schemaVersion: IDENTITY_EVENT_SCHEMA_VERSION,
    tenant: input.tenant,
    seq: input.seq ?? 0,
    time: input.time ?? new Date().toISOString(),
    actor: { kind: "service", id: "yard/identity" },
    correlationId: `corr-${input.identityId}`,
    causationId: `cmd-rotate-${input.identityId}`,
    retention: CREDENTIAL_AUDIT_RETENTION,
    data: asJsonObject({
      identityId: input.identityId,
      previousIdentityId: input.previousIdentityId,
      subject: input.subject,
      svidRef: input.svidRef,
      expiresAt: input.expiresAt,
    }),
  };
}

export function validateIdentityEvent(event: IdentityEvent): void {
  if (event.schemaVersion !== IDENTITY_EVENT_SCHEMA_VERSION) {
    throw new Error("identity event schema version mismatch");
  }
  if (event.type === "identity.Issued") {
    for (const field of ["identityId", "subject", "svidRef", "scope", "expiresAt"] as const) {
      if (event.data[field] === undefined) {
        throw new Error(`identity.Issued missing ${field}`);
      }
    }
  }
  if (event.type === "identity.Rotated") {
    for (const field of ["identityId", "previousIdentityId", "subject", "svidRef", "expiresAt"] as const) {
      if (event.data[field] === undefined) {
        throw new Error(`identity.Rotated missing ${field}`);
      }
    }
  }
}
