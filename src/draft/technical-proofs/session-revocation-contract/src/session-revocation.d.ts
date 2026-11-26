import type { IdentityEvent, PrincipalRef } from "../../identity-event-contract/src/identity-event-contract.d.js";
import { type JsonObject } from "./json.js";


export interface SessionAuthority {
  readonly events: IdentityEvent[];
  readonly liveQueries: Record<string, JsonObject>;
  startSession(input: {
    sessionId: string;
    principal: PrincipalRef;
    expiresAt: string;
    requestId: string;
  }): { ok: true; event: IdentityEvent };
  refreshSession(input: {
    previousSessionId: string;
    sessionId: string;
    principal: PrincipalRef;
    expiresAt: string;
    requestId: string;
  }): { ok: boolean; event?: IdentityEvent; error?: { code: string; previousSessionId?: string } };
  revokeSession(input: {
    sessionId: string;
    reason: string;
    requestId: string;
    observedAt?: string;
  }): { ok: true; event: IdentityEvent; reactiveDecisions: ReactiveDecision[] };
  signOutEverywhere(input: {
    principal: PrincipalRef;
    reason: string;
    requestId: string;
  }): { ok: true; revokedSessionIds: string[]; reactiveDecisions: ReactiveDecision[] };
  attachLiveQuery(input: {
    queryId: string;
    sessionId: string;
    principal: PrincipalRef;
    openedAt: string;
  }): JsonObject;
}

export interface ReactiveDecision {
  queryId: string;
  action: "close";
  reason: "session-revoked";
  sessionId: string;
  propagationMs: number;
}

export function createEventSourcedSessionAuthority(options?: {
  now?: () => Date;
  propagationBudgetMs?: number;
}): SessionAuthority;

export function verifyRequestWithSessionState(input: {
  verification: JsonObject;
  sessionId: string;
  sessionEvents: IdentityEvent[];
  requestId: string;
  now?: Date;
}): JsonObject;

export function replaySessionState(events: IdentityEvent[]): {
  sessions: Record<string, JsonObject>;
  principalSessions: Record<string, string[]>;
};
