import { type JsonValue, type JsonObject } from "./json.js";
export type PrincipalRef = {
  kind: "user" | "agent" | "service" | "workload";
  id: string;
  delegatedBy?: PrincipalRef;
};

export type InboundXaaApp = {
  id: string;
  audience: string;
  resource: string;
  allowedScopes: string[];
};

export type InboundXaaContext = {
  user: {
    kind: "user";
    id: string;
    delegatedFrom: { kind: string; id: string };
    tenant: { app: string };
  };
  identity: PrincipalRef;
  auth: {
    kind: "inbound-xaa";
    issuer: string;
    audience: string;
    resource: string;
    scopes: string[];
    nonce: string;
  };
};

export type InboundXaaCredential = {
  tokenRef: string;
  audience: string;
  resource: string;
  scopes: string[];
  subject: PrincipalRef;
  expiresAt: string;
};

export type InboundXaaAccepted = {
  ok: true;
  requestId: string;
  ctx: InboundXaaContext;
  credential: InboundXaaCredential;
  events: object[];
  idJag: { issuer: string; nonce: string };
};

export type InboundXaaDenied = {
  ok: false;
  code: "untrusted-issuer" | "invalid-id-jag" | "insufficient-scope" | "policy-denied";
  reason: string;
  events: object[];
};

export type InboundXaaResourceServer = {
  acceptIdJag(input: {
    requestId?: string;
    assertion: string;
    requiredScopes?: string[];
  }): Promise<InboundXaaAccepted | InboundXaaDenied>;
};

export function createFixtureIdJagIssuer(input: {
  issuer: string;
  keyId?: string;
}): {
  issuer: string;
  rotate(nextKeyId: string): JsonValue;
  jwks(): { keys: object[] };
  signIdJag(input: {
    issuer?: string;
    subjectId: string;
    subject: PrincipalRef;
    audience: string;
    resource: string;
    clientId: string;
    scopes: string[];
    nonce: string;
    issuedAt: number;
    expiresAt: number;
    extraClaims?: JsonObject;
  }): string;
};

export function createInboundXaaResourceServer(input: {
  app: InboundXaaApp;
  trustedIssuers: Record<string, { keys: JsonObject[] }>;
  now?: () => number;
  idFactory?: (prefix: "grant" | "use") => string;
  eventSink?: (event: JsonObject) => void;
  policyGate?: (request: {
    requestId: string;
    app: InboundXaaApp;
    ctx: InboundXaaContext;
    scopes: string[];
    assertion: { issuer: string; nonce: string };
  }) => boolean | { ok: boolean; reason?: string } | Promise<boolean | { ok: boolean; reason?: string }>;
  tokenTtlSec?: number;
  consumedNonces?: Set<string>;
}): InboundXaaResourceServer;

export function createInboundXaaMcpBridge(input: {
  resourceServer: InboundXaaResourceServer;
  makeMcpServer(request: {
    ctx: InboundXaaContext;
    credential: InboundXaaCredential;
    identity: PrincipalRef;
  }): { callTool(name: string, input?: JsonObject, options?: JsonObject): Promise<JsonValue> };
}): {
  callTool(name: string, input?: JsonObject, authOptions?: JsonObject): Promise<JsonValue>;
};
