import { type JsonValue, type JsonObject } from "./json.js";
export type ExternalAuthFlowType =
  | "oauth2-xaa"
  | "oauth2-obo"
  | "mcp-oauth2.1";

export interface ExternalAuthOperation {
  scope: string;
}

export interface ExternalAuthFlow {
  type: ExternalAuthFlowType;
  idJag?: boolean;
  audience?: string;
  scopes?: readonly string[];
  operations?: Record<string, ExternalAuthOperation>;
}

export interface ExternalAuthJson {
  issuer?: string;
  flows: readonly ExternalAuthFlow[];
}

export interface ConnectorCall<Scope extends string = string> {
  readonly target: string;
  readonly operation: string;
  readonly input: JsonValue;
  readonly scope: Scope;
}

export interface ConnectorBinding<Name extends string = string> {
  readonly name: Name;
  readonly flow: ExternalAuthFlow;
  readonly via: "xaa" | Exclude<ExternalAuthFlowType, "oauth2-xaa">;
  readonly advertisedScopes: readonly string[];
  readonly operationScopes: Readonly<Record<string, string>>;
  readonly declaredAllow?: readonly string[];
  readonly client: Readonly<JsonObject>;
  allow(...scopes: string[]): ConnectorBinding<Name>;
  call(operation: string, input?: JsonValue): ConnectorCall;
}

export interface ConnectorManifestEntry {
  readonly type: "connector.v1";
  readonly via: "xaa" | Exclude<ExternalAuthFlowType, "oauth2-xaa">;
  readonly audience?: string;
  readonly onBehalfOf: "user";
  readonly allow: readonly string[];
  readonly observedScopes: readonly string[];
  readonly declaredAllow?: readonly string[];
  readonly requestedScopeSource: "usage-inferred" | "declared-narrowing";
  readonly usageContract: {
    readonly compareObservedUsage: boolean;
    readonly usageExceedsDeclaredAllow: boolean;
  };
  readonly fallbackFrom?: "oauth2-xaa";
}

export function createConnectorBinding<Name extends string>(
  name: Name,
  authJson: ExternalAuthJson,
  options?: { declaredAllow?: readonly string[] }
): ConnectorBinding<Name>;

export function buildConnectorManifestEntry(
  binding: ConnectorBinding,
  observedOperations?: readonly string[]
): ConnectorManifestEntry;

export function generateConnectorClientDeclaration(binding: ConnectorBinding): string;
export function selectExternalAppFlow(authJson: ExternalAuthJson): ExternalAuthFlow;
