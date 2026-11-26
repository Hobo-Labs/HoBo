import { type JsonValue } from "./json.js";
// domain-view: parse-produced draft-proof record; its wire form is the CollectionInput proto message in data-models/.
export interface CollectionInput {
  readonly bindleId?: string;
  readonly fileName?: string;
  readonly sourceText?: string;
  readonly componentHost?: {
    readonly kind: string;
    readonly version: string;
  };
  readonly define: (collect: CollectionContext) => void;
}

export interface CollectionContext {
  readonly effects: {
    readonly clock: {
      now(): Date;
    };
    readonly network: {
      fetch(target: string): { readonly ok: false; readonly ignored: true };
    };
  };
  bind(from: ResourceHandle, to: ResourceHandle): void;
  api(name: string, options?: ComponentOptions): ComponentHandle;
  web(name: string, options?: ComponentOptions): ComponentHandle;
  service(name: string, options?: ComponentOptions): ComponentHandle;
  job(name: string, options?: ComponentOptions): ComponentHandle;
  kv(name: string): ResourceHandle;
  data(name: string): ResourceHandle;
  bucket(name: string): ResourceHandle;
  queue(name: string): ResourceHandle;
  topic(name: string): ResourceHandle;
  secret(name: string): ResourceHandle;
  schedule(name: string): ResourceHandle;
  websocket(name: string): ResourceHandle;
  flag(name: string): ResourceHandle;
  auth(name: string): ResourceHandle;
  crypto(name: string): ResourceHandle;
  notify(name: string): ResourceHandle;
  guardrail(name: string): ResourceHandle;
  ui(name: string): ResourceHandle;
  golden(name: string): ResourceHandle;
  experiment(name: string): ResourceHandle;
}

export interface ComponentOptions {
  readonly bind?: Record<string, ResourceHandle>;
}

export interface ResourceHandle {
  readonly kind: string;
  readonly name: string;
  readonly stableId: string;
  readonly port: string;
  allow(...verbs: string[]): this;
  [verb: string]: string | ((...args: never[]) => ResourceHandle | JsonValue);
}

export interface ComponentHandle extends ResourceHandle {
  route(method: string, path: string): this;
}

export interface CollectionResult {
  readonly bindleId: string;
  readonly manifest: JsonValue;
  readonly manifestHash: string;
  readonly coverage: {
    readonly ok: boolean;
    readonly status: "pass" | "pass-with-warnings" | "fail";
    readonly diagnostics: readonly unknown[];
    readonly observedResourceIds: readonly string[];
    readonly observedBindKeys: readonly string[];
  };
  readonly events: readonly CollectionFact[];
  readonly sideEffects: readonly unknown[];
}

export interface CollectionFact {
  readonly id: string;
  readonly type: "bindle.ResourcesCollected" | "bindle.ManifestProduced";
  readonly seq: number;
  readonly source: "resource-collection-engine";
  readonly data: JsonValue;
}

export class CollectionEngineError extends Error {
  readonly path: string;
}

export function collectBindleResources(input: CollectionInput): CollectionResult;
