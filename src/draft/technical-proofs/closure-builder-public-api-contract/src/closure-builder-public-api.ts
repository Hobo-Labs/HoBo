import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";
export type BindleRole = "manifest-assembly";
export type AppHostOwner = "imported-app-code";
export type RuntimeHostBehavior = "out-of-scope";

export interface BuilderFactoryContract {
  readonly name: string;
  readonly acceptsResourceName: false;
  readonly identitySource: "hobo-generated";
  readonly aliasRole: "local-and-returned-key-only";
}

// domain-view: parse-produced draft-proof record; its wire form is the ClosureBuilderContract proto message in data-models/.
export interface ClosureBuilderContract {
  readonly packageName: "@hobo/bindles";
  readonly bindleSignature: "bindle(name, builderFn)";
  readonly bindleRole: BindleRole;
  readonly appHostOwner: AppHostOwner;
  readonly runtimeHostBehavior: RuntimeHostBehavior;
  readonly relationshipVerbs: readonly ["dependsOn"];
  readonly builderFactories: readonly BuilderFactoryContract[];
}

export class ClosureBuilderContractError extends Error {
  readonly code: string;
  readonly details: JsonObject;

  constructor(code: string, message: string, details: JsonObject = {}) {
    super(`${code}: ${message}`);
    this.name = "ClosureBuilderContractError";
    this.code = code;
    this.details = details;
  }
}

const BUILDER_FACTORY_NAMES = [
  "api",
  "auth",
  "bucket",
  "cache",
  "config",
  "connector",
  "data",
  "objectStore",
  "queue",
  "secret",
  "service",
  "topic",
  "web",
] as const;

const LEGACY_EXPLICIT_BINDLE_PATTERNS = [
  /\bb\.use\s*\(/,
  /\b(?:api|auth|bucket|cache|data|database|kv|objectStore|queue|secret|service|topic|web)\s*\(\s*["'`][^"'`]+["'`]/,
];

const ALTERNATE_RELATIONSHIP_VERBS = /\.(?:bind|bindTo|linkTo|requires|uses|withReference)\s*\(/;

export function closureBuilderContract(): ClosureBuilderContract {
  return deepFreeze({
    packageName: "@hobo/bindles",
    bindleSignature: "bindle(name, builderFn)",
    bindleRole: "manifest-assembly",
    appHostOwner: "imported-app-code",
    runtimeHostBehavior: "out-of-scope",
    relationshipVerbs: ["dependsOn"],
    builderFactories: BUILDER_FACTORY_NAMES.map((name) => ({
      name,
      acceptsResourceName: false,
      identitySource: "hobo-generated",
      aliasRole: "local-and-returned-key-only",
    })),
  });
}

export function parseClosureBuilderContract(raw: JsonValue): ClosureBuilderContract {
  if (!isRecord(raw)) {
    throw new ClosureBuilderContractError("CLOSURE_BUILDER_PARSE", "contract must be an object");
  }

  if (raw.packageName !== "@hobo/bindles") {
    throw new ClosureBuilderContractError(
      "CLOSURE_BUILDER_PACKAGE_OWNERSHIP",
      "closure-builder v1 app authoring belongs to @hobo/bindles, not @hobo/sdk or topology packages",
      { packageName: raw.packageName },
    );
  }

  if (raw.bindleSignature !== "bindle(name, builderFn)") {
    throw new ClosureBuilderContractError(
      "CLOSURE_BUILDER_SIGNATURE",
      "explicit Bindle authoring must use bindle(name, builderFn)",
      { bindleSignature: raw.bindleSignature },
    );
  }

  if (raw.bindleRole !== "manifest-assembly" || raw.appHostOwner !== "imported-app-code") {
    throw new ClosureBuilderContractError(
      "CLOSURE_BUILDER_APP_HOST_BOUNDARY",
      "Bindle builder assembles manifest objects; imported app/framework code owns app-host behavior",
      { bindleRole: raw.bindleRole, appHostOwner: raw.appHostOwner },
    );
  }

  if (raw.runtimeHostBehavior !== "out-of-scope") {
    throw new ClosureBuilderContractError(
      "CLOSURE_BUILDER_RUNTIME_SCOPE",
      "runtime app-host behavior is out of scope for the public API contract",
      { runtimeHostBehavior: raw.runtimeHostBehavior },
    );
  }

  const relationshipVerbs = readStringArray(raw.relationshipVerbs, "relationshipVerbs");
  if (relationshipVerbs.length !== 1 || relationshipVerbs[0] !== "dependsOn") {
    throw new ClosureBuilderContractError(
      "CLOSURE_BUILDER_RELATIONSHIP_VERB",
      "dependsOn() is the only v1 relationship verb",
      { relationshipVerbs },
    );
  }

  if (!Array.isArray(raw.builderFactories) || raw.builderFactories.length === 0) {
    throw new ClosureBuilderContractError(
      "CLOSURE_BUILDER_FACTORY_MATRIX",
      "builderFactories must list the v1 resource methods",
    );
  }

  const builderFactories = raw.builderFactories.map((entry, index) => parseBuilderFactory(entry, index));

  return deepFreeze({
    packageName: "@hobo/bindles",
    bindleSignature: "bindle(name, builderFn)",
    bindleRole: "manifest-assembly",
    appHostOwner: "imported-app-code",
    runtimeHostBehavior: "out-of-scope",
    relationshipVerbs: ["dependsOn"],
    builderFactories,
  });
}

export function assertClosureBuilderDocument(contract: ClosureBuilderContract): ClosureBuilderContract {
  const parsed = parseClosureBuilderContract(contract);
  const missingFactories = ["api", "cache", "queue", "data"].filter(
    (name) => !parsed.builderFactories.some((factory) => factory.name === name),
  );
  if (missingFactories.length > 0) {
    throw new ClosureBuilderContractError(
      "CLOSURE_BUILDER_FACTORY_COVERAGE",
      "canonical builder factories are missing from the public API contract",
      { missingFactories },
    );
  }
  return parsed;
}

export function assertNoLegacyExplicitBindleSyntax(sourceText: string): string {
  for (const pattern of LEGACY_EXPLICIT_BINDLE_PATTERNS) {
    const match = sourceText.match(pattern);
    if (match) {
      throw new ClosureBuilderContractError(
        "CLOSURE_BUILDER_LEGACY_EXPLICIT_BINDLE",
        "v1 explicit Bindle docs must use closure-builder methods without b.use(...) or named resource factory args",
        { match: match[0] },
      );
    }
  }

  const alternateRelationship = sourceText.match(ALTERNATE_RELATIONSHIP_VERBS);
  if (alternateRelationship) {
    throw new ClosureBuilderContractError(
      "CLOSURE_BUILDER_RELATIONSHIP_VERB",
      "dependsOn() is the only v1 relationship verb",
      { match: alternateRelationship[0] },
    );
  }

  return sourceText;
}

export function renderCodingAgentChecklist(contract: ClosureBuilderContract): string {
  const parsed = assertClosureBuilderDocument(contract);
  const methods = parsed.builderFactories.map((factory) => `b.${factory.name}()`).join(", ");

  return [
    `Use ${parsed.bindleSignature} from ${parsed.packageName}.`,
    "Bindle role: manifest assembly only; imported app-host or framework code owns request handling.",
    `Builder methods take no resource names: ${methods}.`,
    "Resource identity is HoBo-generated; local variables and returned object keys are aliases only.",
    "Use b.api(() => importedApp.run()) for app-host entrypoints.",
    "Use dependsOn() for resource relationships; do not introduce another relationship verb.",
  ].join("\n");
}

function parseBuilderFactory(raw: JsonValue, index: number): BuilderFactoryContract {
  if (!isRecord(raw) || !isJsonString(raw.name) || raw.name.length === 0) {
    throw new ClosureBuilderContractError(
      "CLOSURE_BUILDER_FACTORY_MATRIX",
      "builder factory entry must have a name",
      { index },
    );
  }
  if (raw.acceptsResourceName !== false) {
    throw new ClosureBuilderContractError(
      "CLOSURE_BUILDER_NAMED_RESOURCE_ARG",
      "v1 builder resource factories must not accept resource name arguments",
      { name: raw.name, acceptsResourceName: raw.acceptsResourceName },
    );
  }

  return {
    name: raw.name,
    acceptsResourceName: false,
    identitySource: "hobo-generated",
    aliasRole: "local-and-returned-key-only",
  };
}

function readStringArray(value: JsonValue, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => !isJsonString(entry))) {
    throw new ClosureBuilderContractError(
      "CLOSURE_BUILDER_PARSE",
      `${field} must be a string array`,
      { field },
    );
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
    // SAFETY: `return Object.freeze(value) as T;` is required at this I/O or test boundary.
    return Object.freeze(value) as T;
  }
  if (isRecord(value)) {
    Object.values(value).forEach(deepFreeze);
    // SAFETY: `return Object.freeze(value) as T;` is required at this I/O or test boundary.
    return Object.freeze(value) as T;
  }
  return value;
}

function isRecord(value: JsonValue): value is JsonObject {
  return isJsonObject(value) && value !== null && !Array.isArray(value);
}
