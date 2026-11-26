import { type JsonValue, type JsonObject } from "./json.js";
export const DEFAULT_COMPONENT_HOST = Object.freeze({
  kind: "wasmtime",
  version: "46.0.1",
});

// domain-view: parse-produced draft-proof record; its wire form is the ComponentHost proto message in data-models/.
export type ComponentHost = {
  readonly kind: string;
  readonly version: string;
};

export type SideEffectRecord =
  | { readonly kind: "clock.now"; readonly disposition: "ignored" }
  | {
      readonly kind: "network.fetch";
      readonly target: string;
      readonly disposition: "ignored";
    };

// domain-view: parse-produced draft-proof record; its wire form is the CoverageDiagnostic proto message in data-models/.
export type CoverageDiagnostic = {
  readonly code: string;
  readonly severity: string;
  readonly message?: string;
  readonly resourceId?: string;
  readonly bindKey?: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the CoverageSummary proto message in data-models/.
export type CoverageSummary = {
  readonly ok: boolean;
  readonly canDeployDimension?: string;
  readonly status: string;
  readonly observedResourceIds: readonly string[];
  readonly observedBindKeys: readonly string[];
  readonly declaredResources?: readonly unknown[];
  readonly declaredBinds?: readonly unknown[];
  readonly unobservedDeclarations?: readonly { readonly resourceId: string }[];
  readonly unobservedBinds?: readonly unknown[];
  readonly unreachableDeclarations?: readonly unknown[];
  readonly unreachableBinds?: readonly unknown[];
  readonly unresolvedDeclarations?: readonly unknown[];
  readonly unresolvedBinds?: readonly unknown[];
  readonly diagnostics: readonly CoverageDiagnostic[];
};

export type CoverageEvaluatorContext = {
  readonly bindleId: string;
  readonly fileName: string;
  readonly sourceText: string;
  readonly observedResourceIds: readonly string[];
  readonly observedBindKeys: readonly string[];
};

export type CoverageEvaluator = (
  context: CoverageEvaluatorContext,
) => CoverageSummary;

// domain-view: parse-produced draft-proof record; its wire form is the CollectionInput proto message in data-models/.
export type CollectionInput = {
  readonly bindleId: string;
  readonly fileName: string;
  readonly sourceText: string;
  readonly componentHost: ComponentHost;
  readonly define: (collect: CollectionContext) => void;
  readonly coverageEvaluator?: CoverageEvaluator;
};

// domain-view: parse-produced draft-proof record; its wire form is the CollectionEvent proto message in data-models/.
export type CollectionEvent = {
  readonly id: string;
  readonly type: "bindle.ResourcesCollected" | "bindle.ManifestProduced";
  readonly seq: 1 | 2;
  readonly source: "hobo.collector";
  readonly data: JsonObject;
};

export type CollectionResult = {
  readonly bindleId: string;
  readonly manifest: JsonObject;
  readonly manifestHash: string;
  readonly coverage: CoverageSummary;
  readonly events: readonly CollectionEvent[];
  readonly sideEffects: readonly SideEffectRecord[];
};

export type ResolvedResource = {
  readonly kind: string;
  readonly name: string;
  readonly port: string;
};

export type ResourceRecord = {
  kind: string;
  name: string;
  stableId: string;
  port: string;
  portRef: string[];
  usedVerbs: Set<string>;
  routes: Array<{ method: string; path: string }>;
  bindAliases: Map<string, ResolvedResource>;
};

export type BindEdge = {
  from: string;
  to: string;
  key: string;
  import: string;
};

export type CollectionState = {
  resources: Map<string, ResourceRecord>;
  bindEdges: BindEdge[];
  sideEffects: SideEffectRecord[];
};

export type CatalogEntry = {
  readonly factory: string;
  readonly portRef: readonly string[];
  readonly allowVerbs: readonly string[];
};

export type CollectionEffects = {
  readonly clock: { readonly now: () => Date };
  readonly network: {
    readonly fetch: (target: string) => { readonly ok: false; readonly ignored: true };
  };
};

export type CollectionBind = (from: ResourceHandle, to: ResourceHandle) => void;

export type ResourceFactory = (
  name: string,
  options?: { readonly bind?: JsonObject },
) => ResourceHandle;

export type CollectionContext = {
  readonly effects: CollectionEffects;
  readonly bind: CollectionBind;
  readonly [factory: string]: ResourceFactory | CollectionEffects | CollectionBind;
};

export type ResourceVerbFn = (...args: JsonValue[]) => JsonObject;

export type ResourceHandle = {
  readonly kind: string;
  readonly name: string;
  readonly stableId: string;
  readonly port: string;
  readonly route: (method: string, path: string, handler?: () => void) => ResourceHandle;
  readonly allow: (...verbs: string[]) => ResourceHandle;
  readonly [verb: string]: string | ResourceVerbFn | ((...args: never[]) => ResourceHandle);
};
