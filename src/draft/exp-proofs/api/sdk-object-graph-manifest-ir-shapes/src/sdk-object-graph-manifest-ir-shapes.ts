import { isJsonObject, type JsonObject, type JsonValue } from "./json.js";
export const REQUIRED_EXAMPLE_KINDS = [
  "desired-resource-graph",
  "provider-capability-reference",
  "deployment-plan-request",
  "migration-plan-request",
  "inspect-log-subscription-reader",
] as const;

export const REQUIRED_DEBT_MARKERS = ["raw-provider-edge", "authoritative-external-resource"] as const;

export const REQUIRED_DESIGN_ANCHORS = [
  "docs/design/developer-experience.md#plan-07",
  "docs/design/sdk-api.md#plan-02",
  "docs/design/control-plane.md#plan-04",
  "docs/design/platform-engineering.md#plan-25",
  "docs/design/data-plane.md#plan-32",
  "docs/design/closure-builder-public-api.md",
  "docs/design/sdk-contracts.md",
] as const;

export type ExampleKind = (typeof REQUIRED_EXAMPLE_KINDS)[number];
export type DebtMarkerKind = (typeof REQUIRED_DEBT_MARKERS)[number];
export type DesignAnchor = (typeof REQUIRED_DESIGN_ANCHORS)[number];

export type ProofMode = "live" | "simulated" | "reference-fixture" | "scope-out" | "type-test";

// domain-view: parse-produced draft-proof record; its wire form is the Audience proto message in data-models/.
export interface Audience {
  actor: string;
  goal: string;
  friction: string;
  successCriteria: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the TypeSurface proto message in data-models/.
export interface TypeSurface {
  importFrom: "@hobo/bindles";
  generatedBindings: string[];
  manifestVersion: "hobo.manifest/v1";
  lowersTo: "hobo:sdk WIT bindings";
  compileProof: "type-test";
}

export interface CompileConsumerEvidence {
  importFrom: "@hobo/bindles";
  generatedBindings: string[];
  manifestVersion: "hobo.manifest/v1";
  resourceRefs: string[];
  typedClientCalls: string[];
  debtMarkers: DebtMarkerKind[];
}

export type ResourceReferenceKind =
  | "bindle"
  | "camp"
  | "yard"
  | "junction"
  | "api"
  | "cache"
  | "provider-capability"
  | "authoritative-external";

export interface ResourceReference {
  generatedId: `res_${string}`;
  alias: string;
  kind: ResourceReferenceKind;
  proofMode: ProofMode;
  debtMarkers: DebtMarkerKind[];
}

export interface HoboBindlesObjectGraph {
  importFrom: "@hobo/bindles";
  bindle: ResourceReference;
  camp: ResourceReference;
  yard: ResourceReference;
  junction: ResourceReference;
  resources: [ResourceReference, ResourceReference, ...ResourceReference[]];
}

export interface GeneratedWitBindingReference {
  module: `hobo:sdk/${string}`;
  exportName: string;
}

export interface ManifestIrFixture {
  version: "hobo.manifest/v1";
  generatedBindings: [GeneratedWitBindingReference, GeneratedWitBindingReference, ...GeneratedWitBindingReference[]];
  resources: [ResourceReference, ResourceReference, ...ResourceReference[]];
  rawProviderEdges: string[];
  authoritativeExternalResources: string[];
}

export interface DeploymentPlanRequestFixture {
  manifestDigest: `sha256:${string}`;
  camp: string;
  objective: "balanced" | "lowest-cost" | "least-change";
  policyContext: "reference-fixture";
}

export interface MigrationPlanRequestFixture {
  adoptedResource: ResourceReference;
  phases: ["expand", "backfill", "contract"];
  snapshotRequired: true;
}

export interface SubscriptionReaderFixture {
  stream: "inspect" | "logs";
  projection: string;
  seq: number;
  freshness: "snapshot" | "tail";
  redaction: "tenant-safe";
}

export interface TypedClientCallsFixture {
  deploymentPlanRequest: DeploymentPlanRequestFixture;
  migrationPlanRequest: MigrationPlanRequestFixture;
  inspectReader: SubscriptionReaderFixture;
  logReader: SubscriptionReaderFixture;
}

export interface SdkCompileConsumer {
  objectGraph: HoboBindlesObjectGraph;
  manifestIr: ManifestIrFixture;
  typedClientCalls: TypedClientCallsFixture;
}

// domain-view: parse-produced draft-proof record; its wire form is the ExampleConsumer proto message in data-models/.
export interface ExampleConsumer {
  kind: ExampleKind;
  proofMode: ProofMode;
  fixtureId: string;
  fixtureInput: string;
  fixtureOutput: string;
  sdkSnippet: string;
  manifestIrContract: string;
  expectedArtifact: string;
  typeSurface: TypeSurface;
}

// domain-view: parse-produced draft-proof record; its wire form is the DebtMarker proto message in data-models/.
export interface DebtMarker {
  kind: DebtMarkerKind;
  surfacedBy: string[];
  authorMessage: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the ScopeBoundary proto message in data-models/.
export interface ScopeBoundary {
  in: string[];
  out: string[];
}

// domain-view: parse-produced draft-proof record; its wire form is the SdkObjectGraphProof proto message in data-models/.
export interface SdkObjectGraphProof {
  issue: "HOBO-568";
  parentIssue: "HOBO-566";
  phase: "M1";
  targetPackage: "src/draft/exp-proofs/api/sdk-object-graph-manifest-ir-shapes";
  proofNote: "docs/design/proofs/sdk-object-graph-manifest-ir-shapes/README.md";
  designAnchors: DesignAnchor[];
  audience: Audience[];
  proofModeLabels: ProofMode[];
  typeSurface: TypeSurface;
  exampleConsumers: ExampleConsumer[];
  debtMarkers: DebtMarker[];
  scopeBoundary: ScopeBoundary;
  compileExpectations: string[];
  compileConsumers: CompileConsumerEvidence[];
}

const PARSED = Symbol("ParsedSdkObjectGraphProof");

export type ParsedSdkObjectGraphProof = SdkObjectGraphProof & {
  readonly [PARSED]: true;
};

const VALID_PROOF_MODES = new Set<ProofMode>(["live", "simulated", "reference-fixture", "scope-out", "type-test"]);

const SCOPE_CREEP_PATTERNS = [
  /\bpublish(?:ing)? real @hobo\/bindles\b/i,
  /\breal @hobo\/bindles\b/i,
  /\bproduction bindings?\b/i,
  /\blive cloud\b/i,
  /\breal credentials?\b/i,
  /\bruntime implementation\b/i,
  /\bnew SDK semantics\b/i,
  /\bprovider execution\b/i,
];

export const SDK_OBJECT_GRAPH_MANIFEST_IR_PROOF: SdkObjectGraphProof = {
  issue: "HOBO-568",
  parentIssue: "HOBO-566",
  phase: "M1",
  targetPackage: "src/draft/exp-proofs/api/sdk-object-graph-manifest-ir-shapes",
  proofNote: "docs/design/proofs/sdk-object-graph-manifest-ir-shapes/README.md",
  designAnchors: [...REQUIRED_DESIGN_ANCHORS],
  audience: [
    {
      actor: "app developer",
      goal: "Declare a small Bindle/Camp object graph and see the manifest IR shape before any provider is selected.",
      friction: "The SDK must feel typed and discoverable without hiding which pieces are reference fixtures.",
      successCriteria: "The example consumer compiles against the thin idiom surface and emits inspectable manifest IR fixtures.",
    },
    {
      actor: "platform engineer",
      goal: "Review provider capability references, resource debt, and DeploymentPlan request fixtures before implementation.",
      friction: "Provider-specific choices must be visible and reviewable instead of buried in SDK calls.",
      successCriteria: "Debt markers and plan request fixtures expose `.raw()` and adopted/external resources as explicit risks.",
    },
    {
      actor: "agent/MCP caller",
      goal: "Use the same resource graph, plan, migration, inspect, and log fixture ids through API/MCP paths.",
      friction: "Automation needs stable artifacts and refusal labels instead of prose-only examples.",
      successCriteria: "Every example names fixture ids, proof modes, and expected artifacts an agent can cite.",
    },
  ],
  proofModeLabels: ["live", "simulated", "reference-fixture", "scope-out", "type-test"],
  typeSurface: {
    importFrom: "@hobo/bindles",
    generatedBindings: ["hobo:sdk/bindle", "hobo:sdk/manifest", "hobo:sdk/deployment-plan", "hobo:sdk/migration"],
    manifestVersion: "hobo.manifest/v1",
    lowersTo: "hobo:sdk WIT bindings",
    compileProof: "type-test",
  },
  exampleConsumers: [
    {
      kind: "desired-resource-graph",
      proofMode: "type-test",
      fixtureId: "sdk-object-graph.todo-cache-api.v1",
      fixtureInput: "fixtures/input/todo-api.sdk.ts",
      fixtureOutput: "fixtures/output/todo-api.manifest.json",
      sdkSnippet:
        "bindle('todo-api', b => ({ api: b.api(() => app.run()).dependsOn('cache'), cache: b.cache() }))",
      manifestIrContract: "resources[].generatedId + dependsOn[] + workload import boundary",
      expectedArtifact: "manifest-ir/todo-api-resources.json",
      typeSurface: {
        importFrom: "@hobo/bindles",
        generatedBindings: ["hobo:sdk/bindle", "hobo:sdk/manifest"],
        manifestVersion: "hobo.manifest/v1",
        lowersTo: "hobo:sdk WIT bindings",
        compileProof: "type-test",
      },
    },
    {
      kind: "provider-capability-reference",
      proofMode: "reference-fixture",
      fixtureId: "sdk-object-graph.provider-capability.postgres.v1",
      fixtureInput: "fixtures/input/provider-capability-ref.json",
      fixtureOutput: "fixtures/output/provider-capability-manifest.json",
      sdkSnippet: "camp('prod').prefer(provider.azure.postgres().raw('azure.flexible-server')).require('managed-postgres')",
      manifestIrContract: "providerCapabilityRef + portabilityDebt[] + capabilityRequirement[]",
      expectedArtifact: "manifest-ir/provider-capability-refs.json",
      typeSurface: {
        importFrom: "@hobo/bindles",
        generatedBindings: ["hobo:sdk/provider", "hobo:sdk/manifest"],
        manifestVersion: "hobo.manifest/v1",
        lowersTo: "hobo:sdk WIT bindings",
        compileProof: "type-test",
      },
    },
    {
      kind: "deployment-plan-request",
      proofMode: "reference-fixture",
      fixtureId: "sdk-object-graph.deployment-plan.request.v1",
      fixtureInput: "fixtures/input/deployment-plan-request.json",
      fixtureOutput: "fixtures/output/deployment-plan-request.accepted.json",
      sdkSnippet: "plans.request({ bindle, camp: 'prod', objective: 'balanced' })",
      manifestIrContract: "DeploymentPlanRequest{manifestDigest,camp,objective,policyContext}",
      expectedArtifact: "plans/deployment-plan-request.json",
      typeSurface: {
        importFrom: "@hobo/bindles",
        generatedBindings: ["hobo:sdk/deployment-plan", "hobo:sdk/manifest"],
        manifestVersion: "hobo.manifest/v1",
        lowersTo: "hobo:sdk WIT bindings",
        compileProof: "type-test",
      },
    },
    {
      kind: "migration-plan-request",
      proofMode: "reference-fixture",
      fixtureId: "sdk-object-graph.migration-plan.request.v1",
      fixtureInput: "fixtures/input/migration-plan-request.json",
      fixtureOutput: "fixtures/output/migration-plan-request.accepted.json",
      sdkSnippet: "migrations.plan({ adopted: external('billing-db'), phases: ['expand', 'backfill', 'contract'] })",
      manifestIrContract: "MigrationPlanRequest{adoptedResource,phaseSequence,snapshotRequired}",
      expectedArtifact: "migrations/migration-plan-request.json",
      typeSurface: {
        importFrom: "@hobo/bindles",
        generatedBindings: ["hobo:sdk/migration", "hobo:sdk/manifest"],
        manifestVersion: "hobo.manifest/v1",
        lowersTo: "hobo:sdk WIT bindings",
        compileProof: "type-test",
      },
    },
    {
      kind: "inspect-log-subscription-reader",
      proofMode: "simulated",
      fixtureId: "sdk-object-graph.inspect-logs.reader.v1",
      fixtureInput: "fixtures/input/inspect-log-reader-request.json",
      fixtureOutput: "fixtures/output/inspect-log-reader.snapshot.json",
      sdkSnippet: "inspect.deploy('dep_123').subscribe(); logs.follow({ resource: 'api' })",
      manifestIrContract: "SubscriptionReader{projection,seq,freshness,redaction}",
      expectedArtifact: "readers/inspect-log-subscription.json",
      typeSurface: {
        importFrom: "@hobo/bindles",
        generatedBindings: ["hobo:sdk/inspect", "hobo:sdk/logs"],
        manifestVersion: "hobo.manifest/v1",
        lowersTo: "hobo:sdk WIT bindings",
        compileProof: "type-test",
      },
    },
  ],
  debtMarkers: [
    {
      kind: "raw-provider-edge",
      surfacedBy: ["manifest IR portabilityDebt", "hobo doctor", "DeploymentPlan warning"],
      authorMessage: ".raw() is allowed only as an explicit provider/dialect escape hatch and is never hidden inside the agnostic SDK path.",
    },
    {
      kind: "authoritative-external-resource",
      surfacedBy: ["manifest IR adoptionDebt", "migration plan warning", "support handoff note"],
      authorMessage:
        "Authoritative-external resources can participate in strangler migration, but they stay marked as adopted/external until migrated or deliberately retained.",
    },
  ],
  scopeBoundary: {
    in: [
      "SDK-facing example consumers for Bindle, Camp, Yard, Junction, provider capability, DeploymentPlan, migration plan, inspect, and log reader shapes.",
      "Compile/type-test expectations over interface declarations and generated WIT binding names.",
      "Deterministic fixture ids and expected manifest IR outputs for API, SDK, CLI, and MCP follow-up slices.",
      "Debt markers for `.raw()` and authoritative-external resources.",
    ],
    out: [
      "No publishing real @hobo/bindles package.",
      "No production bindings or generated client implementation.",
      "No live cloud calls, real credentials, customer data, or provider execution.",
      "No new SDK semantics beyond the WIT-first contract and thin idiom layer.",
    ],
  },
  compileExpectations: [
    "Example consumers use `@hobo/bindles` declarations only as interface shape, not a published package.",
    "The package test runs `tsc --noEmit` over SDK compile consumers before runtime proof assertions.",
    "Generated binding names are stable strings that follow the hobo:sdk WIT contract.",
    "Manifest IR fixtures carry generated resource ids, dependency edges, portability/adoption debt, and proof-mode labels.",
  ],
  compileConsumers: [
    {
      importFrom: "@hobo/bindles",
      generatedBindings: ["hobo:sdk/bindle", "hobo:sdk/manifest", "hobo:sdk/deployment-plan", "hobo:sdk/migration"],
      manifestVersion: "hobo.manifest/v1",
      resourceRefs: ["res_api", "res_cache", "res_provider_postgres", "res_external_billing_db"],
      typedClientCalls: ["deploymentPlanRequest", "migrationPlanRequest", "inspectReader", "logReader"],
      debtMarkers: ["raw-provider-edge", "authoritative-external-resource"],
    },
  ],
};

export const SDK_TYPECHECK_CONSUMERS = {
  todoApi: {
    objectGraph: {
      importFrom: "@hobo/bindles",
      bindle: {
        generatedId: "res_bindle_todo_api",
        alias: "todo-api",
        kind: "bindle",
        proofMode: "type-test",
        debtMarkers: [],
      },
      camp: {
        generatedId: "res_camp_prod",
        alias: "prod",
        kind: "camp",
        proofMode: "reference-fixture",
        debtMarkers: [],
      },
      yard: {
        generatedId: "res_yard_app",
        alias: "app-yard",
        kind: "yard",
        proofMode: "reference-fixture",
        debtMarkers: [],
      },
      junction: {
        generatedId: "res_junction_api_cache",
        alias: "api-cache",
        kind: "junction",
        proofMode: "reference-fixture",
        debtMarkers: [],
      },
      resources: [
        {
          generatedId: "res_api",
          alias: "api",
          kind: "api",
          proofMode: "type-test",
          debtMarkers: [],
        },
        {
          generatedId: "res_cache",
          alias: "cache",
          kind: "cache",
          proofMode: "reference-fixture",
          debtMarkers: [],
        },
        {
          generatedId: "res_provider_postgres",
          alias: "postgres",
          kind: "provider-capability",
          proofMode: "reference-fixture",
          debtMarkers: ["raw-provider-edge"],
        },
        {
          generatedId: "res_external_billing_db",
          alias: "billing-db",
          kind: "authoritative-external",
          proofMode: "reference-fixture",
          debtMarkers: ["authoritative-external-resource"],
        },
      ],
    },
    manifestIr: {
      version: "hobo.manifest/v1",
      generatedBindings: [
        { module: "hobo:sdk/bindle", exportName: "Bindle" },
        { module: "hobo:sdk/manifest", exportName: "ManifestIr" },
        { module: "hobo:sdk/deployment-plan", exportName: "DeploymentPlanRequest" },
        { module: "hobo:sdk/migration", exportName: "MigrationPlanRequest" },
      ],
      resources: [
        {
          generatedId: "res_api",
          alias: "api",
          kind: "api",
          proofMode: "type-test",
          debtMarkers: [],
        },
        {
          generatedId: "res_cache",
          alias: "cache",
          kind: "cache",
          proofMode: "reference-fixture",
          debtMarkers: [],
        },
        {
          generatedId: "res_provider_postgres",
          alias: "postgres",
          kind: "provider-capability",
          proofMode: "reference-fixture",
          debtMarkers: ["raw-provider-edge"],
        },
      ],
      rawProviderEdges: ["azure.flexible-server"],
      authoritativeExternalResources: ["billing-db"],
    },
    typedClientCalls: {
      deploymentPlanRequest: {
        manifestDigest: "sha256:todoapifixture000000000000000000000000000000000000000000000000000000",
        camp: "prod",
        objective: "balanced",
        policyContext: "reference-fixture",
      },
      migrationPlanRequest: {
        adoptedResource: {
          generatedId: "res_external_billing_db",
          alias: "billing-db",
          kind: "authoritative-external",
          proofMode: "reference-fixture",
          debtMarkers: ["authoritative-external-resource"],
        },
        phases: ["expand", "backfill", "contract"],
        snapshotRequired: true,
      },
      inspectReader: {
        stream: "inspect",
        projection: "deployment.current",
        seq: 42,
        freshness: "snapshot",
        redaction: "tenant-safe",
      },
      logReader: {
        stream: "logs",
        projection: "resource.api.logs",
        seq: 43,
        freshness: "tail",
        redaction: "tenant-safe",
      },
    },
  },
} satisfies Record<string, SdkCompileConsumer>;

export function parseSdkObjectGraphProof(input: JsonValue): ParsedSdkObjectGraphProof {
  if (!isRecord(input)) {
    throw new Error("SDK object graph proof must be an object");
  }

  const proof = asSdkObjectGraphProof(input);
  const errors = validateSdkObjectGraphProof(proof);

  if (errors.length > 0) {
    throw new Error(`Invalid SDK object graph proof: ${errors.join("; ")}`);
  }

  return Object.freeze({
    ...proof,
    [PARSED]: true as const,
  });
}

export function validateSdkObjectGraphProof(proof: SdkObjectGraphProof): string[] {
  const errors: string[] = [];

  if (proof.issue !== "HOBO-568") {
    errors.push("issue must be HOBO-568");
  }
  if (proof.parentIssue !== "HOBO-566") {
    errors.push("parent issue must be HOBO-566");
  }
  if (proof.phase !== "M1") {
    errors.push("phase must be M1");
  }
  if (proof.targetPackage !== "src/draft/exp-proofs/api/sdk-object-graph-manifest-ir-shapes") {
    errors.push("target package path must match HOBO-568 acceptance");
  }
  if (proof.proofNote !== "docs/design/proofs/sdk-object-graph-manifest-ir-shapes/README.md") {
    errors.push("proof note path must match HOBO-568 acceptance");
  }

  for (const anchor of REQUIRED_DESIGN_ANCHORS) {
    if (!(proof.designAnchors ?? []).includes(anchor)) {
      errors.push(`missing design anchor: ${anchor}`);
    }
  }

  const actors = new Set((proof.audience ?? []).map((entry) => entry.actor));
  for (const actor of ["app developer", "platform engineer", "agent/MCP caller"]) {
    if (!actors.has(actor)) {
      errors.push(`missing audience: ${actor}`);
    }
  }

  // SAFETY: `for (const proofMode of ["live", "simulated", "reference-fixture", "scope-out", ` is required at this I/O or test boundary.
  for (const proofMode of ["live", "simulated", "reference-fixture", "scope-out", "type-test"] as ProofMode[]) {
    if (!(proof.proofModeLabels ?? []).includes(proofMode)) {
      errors.push(`missing proof-mode label: ${proofMode}`);
    }
  }

  validateTypeSurface(proof.typeSurface, errors, "root type surface");

  const examples = proof.exampleConsumers ?? [];
  for (const kind of REQUIRED_EXAMPLE_KINDS) {
    if (!examples.some((example) => example.kind === kind)) {
      errors.push(`missing example consumer kind: ${kind}`);
    }
  }

  for (const example of examples) {
    if (!VALID_PROOF_MODES.has(example.proofMode)) {
      errors.push(`invalid proof mode for ${example.kind}`);
    }
    if (!example.fixtureId?.startsWith("sdk-object-graph.")) {
      errors.push(`example ${example.kind} must use a stable sdk-object-graph fixture id`);
    }
    if (!example.fixtureInput || !example.fixtureOutput) {
      errors.push(`example ${example.kind} must name deterministic fixture input and output`);
    }
    if (!example.sdkSnippet || !example.manifestIrContract || !example.expectedArtifact) {
      errors.push(`example ${example.kind} must name snippet, manifest shape, and expected artifact`);
    }
    validateTypeSurface(example.typeSurface, errors, `${example.kind} type surface`);
    rejectScopeCreep(`${example.kind} ${example.sdkSnippet} ${example.manifestIrContract}`, errors);
  }

  for (const debtKind of REQUIRED_DEBT_MARKERS) {
    const marker = (proof.debtMarkers ?? []).find((entry) => entry.kind === debtKind);
    if (!marker) {
      errors.push(`missing debt marker: ${debtKind}`);
      continue;
    }
    if ((marker.surfacedBy ?? []).length < 2 || !marker.authorMessage) {
      errors.push(`debt marker ${debtKind} must name at least two surfaces and author guidance`);
    }
  }

  if ((proof.scopeBoundary?.in ?? []).length < 3) {
    errors.push("scope in must name SDK examples, compile proof, and deterministic fixtures");
  }
  if ((proof.scopeBoundary?.out ?? []).length < 4) {
    errors.push("scope out must preserve publishing, production bindings, live cloud, and SDK semantics boundaries");
  }
  for (const scopedIn of proof.scopeBoundary?.in ?? []) {
    rejectScopeCreep(scopedIn, errors);
  }
  for (const scopedOut of proof.scopeBoundary?.out ?? []) {
    if (!SCOPE_CREEP_PATTERNS.some((pattern) => pattern.test(scopedOut))) {
      errors.push(`scope-out entry must name an explicit forbidden boundary: ${scopedOut}`);
    }
  }

  if ((proof.compileExpectations ?? []).length < 3) {
    errors.push("compile expectations must cover interface-only examples, WIT binding names, and manifest IR fixtures");
  }
  if ((proof.compileConsumers ?? []).length < 1) {
    errors.push("compile consumers must include at least one SDK typecheck consumer");
  }
  for (const compileConsumer of proof.compileConsumers ?? []) {
    if (compileConsumer.importFrom !== "@hobo/bindles") {
      errors.push("compile consumer must import from @hobo/bindles");
    }
    if (
      (compileConsumer.generatedBindings ?? []).length < 2 ||
      !compileConsumer.generatedBindings.every((binding) => binding.startsWith("hobo:sdk/"))
    ) {
      errors.push("compile consumer must name generated hobo:sdk bindings");
    }
    if (compileConsumer.manifestVersion !== "hobo.manifest/v1") {
      errors.push("compile consumer must target hobo.manifest/v1");
    }
    for (const debtKind of REQUIRED_DEBT_MARKERS) {
      if (!(compileConsumer.debtMarkers ?? []).includes(debtKind)) {
        errors.push(`compile consumer missing debt marker: ${debtKind}`);
      }
    }
    for (const clientCall of ["deploymentPlanRequest", "migrationPlanRequest", "inspectReader", "logReader"]) {
      if (!(compileConsumer.typedClientCalls ?? []).includes(clientCall)) {
        errors.push(`compile consumer missing typed client call: ${clientCall}`);
      }
    }
  }

  return errors;
}

export function isParsedSdkObjectGraphProof(
  input: JsonValue | ParsedSdkObjectGraphProof,
): input is ParsedSdkObjectGraphProof {
  if (input === null || Array.isArray(input)) {
    return false;
  }
  // SAFETY: `return (input as ParsedSdkObjectGraphProof)[PARSED] === true;` is required at this I/O or test boundary.
  return (input as ParsedSdkObjectGraphProof)[PARSED] === true;
}

function asSdkObjectGraphProof(value: JsonObject): SdkObjectGraphProof {
  // SAFETY: `return value as JsonObject & SdkObjectGraphProof;` is required at this I/O or test boundary.
  return value as JsonObject & SdkObjectGraphProof;
}

function validateTypeSurface(typeSurface: TypeSurface | undefined, errors: string[], label: string) {
  if (!typeSurface) {
    errors.push(`${label} missing`);
    return;
  }
  if (typeSurface.importFrom !== "@hobo/bindles") {
    errors.push(`${label} must import from @hobo/bindles`);
  }
  if ((typeSurface.generatedBindings ?? []).length < 2 || !typeSurface.generatedBindings.every((binding) => binding.startsWith("hobo:sdk/"))) {
    errors.push(`${label} must name generated hobo:sdk bindings`);
  }
  if (typeSurface.manifestVersion !== "hobo.manifest/v1") {
    errors.push(`${label} must lower to hobo.manifest/v1`);
  }
  if (typeSurface.lowersTo !== "hobo:sdk WIT bindings") {
    errors.push(`${label} must lower to hobo:sdk WIT bindings`);
  }
  if (typeSurface.compileProof !== "type-test") {
    errors.push(`${label} must be protected by type-test proof`);
  }
}

function rejectScopeCreep(value: string, errors: string[]) {
  for (const pattern of SCOPE_CREEP_PATTERNS) {
    if (pattern.test(value)) {
      errors.push(`scope creep detected: ${value}`);
      break;
    }
  }
}

function isRecord(input: JsonValue): input is JsonObject {
  return isJsonObject(input) && input !== null && !Array.isArray(input);
}
