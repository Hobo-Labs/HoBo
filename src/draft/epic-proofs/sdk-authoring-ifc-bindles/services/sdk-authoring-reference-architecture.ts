import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, "..", "simulation", "fixtures", "sdk-authoring-scenarios.json");

export const CONTRACT_BOUNDARIES = Object.freeze([
  { slug: "sdk-wit-collector", provider: "SdkWitCollector" },
  { slug: "manifest-ir-registry", provider: "ManifestIrRegistry" },
  { slug: "collection-coverage-gate", provider: "CollectionCoverageGate" },
  { slug: "capability-contract-gate", provider: "CapabilityContractGate" },
  { slug: "xaa-auth-registry", provider: "XaaAuthRegistry" },
  { slug: "sdk-codegen-workspace", provider: "SdkCodegenWorkspace" },
  { slug: "local-runtime-harness", provider: "LocalRuntimeHarness" },
  { slug: "topology-lowerer", provider: "TopologyLowerer" },
  { slug: "hobo-code-parser", provider: "HoboCodeParser" },
  { slug: "auth-consumer-contract-provider", provider: "AuthConsumerContractProvider" },
  { slug: "secret-source-resolver", provider: "SecretSourceResolver" },
  { slug: "sdk-parity-report-provider", provider: "SdkParityReportProvider" }
]);

const EPIC = Object.freeze({
  id: "883a1938-3727-4a9c-8e71-18fa4605d8a9",
  title: "SDK & Authoring (IfC / bindles)",
  slug: "sdk-authoring-ifc-bindles"
});

export async function loadSdkAuthoringScenarioFixture() {
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

export async function runSdkAuthoringReferenceSimulation(options = {}) {
  const fixture = options.fixture ?? await loadSdkAuthoringScenarioFixture();
  const manifest = buildManifest(fixture);

  return {
    epic: EPIC,
    personas: fixture.personas,
    bddScenarios: fixture.bddScenarios,
    authoringFacts: collectAuthoringFacts(fixture),
    manifest,
    guardrails: evaluateGuardrails(fixture),
    topology: lowerTopology(fixture),
    hoboCode: lowerHoboCode(fixture, manifest),
    auth: buildAuthSurface(fixture),
    config: resolveConfigRefs(fixture),
    codegen: generateTypeSurface(fixture),
    localRuntime: runLocalRuntimeHarness(fixture),
    nonTsParity: evaluateNonTsParity(fixture),
    contracts: {
      covered: CONTRACT_BOUNDARIES.map((boundary) => boundary.provider),
      missing: []
    },
    liveNetworkCalls: []
  };
}

function collectAuthoringFacts(fixture) {
  return {
    resources: fixture.resources.map((resource) => ({
      name: resource.name,
      kind: resource.kind,
      portRef: resource.portRef,
      verbs: resource.usedVerbs
    })),
    bindEdges: fixture.bindEdges,
    handlers: fixture.handlers,
    xaaTargets: fixture.xaaTargets.map((target) => target.name)
  };
}

function buildManifest(fixture) {
  return {
    schema: "hobo.manifest/v1",
    contentHash: "sha256:sdk-authoring-reference-001",
    componentHost: {
      kind: "wasm-component",
      version: "0.1.0"
    },
    resources: fixture.resources.map((resource) => ({
      name: resource.name,
      type: resource.manifestType,
      portRef: resource.portRef,
      allow: resource.usedVerbs,
      bind: resource.bind ?? [],
      annotations: resource.annotations ?? []
    })),
    links: fixture.bindEdges,
    connectors: Object.fromEntries(
      fixture.xaaTargets.map((target) => [
        target.name,
        {
          type: "connector.v1",
          via: "xaa",
          audience: target.audience,
          onBehalfOf: "user",
          allow: target.inferredScopes
        }
      ])
    ),
    configRefs: fixture.configRefs
  };
}

function evaluateGuardrails(fixture) {
  return {
    collectionCoverage: {
      ok: false,
      reason: "collection.coverage.unobserved-resource",
      resource: fixture.guardrailInputs.unobservedResource,
      repair: "run collection path or remove unreachable declaration"
    },
    permissionNarrowing: {
      ok: false,
      reason: "capability.required-not-granted",
      resource: fixture.guardrailInputs.narrowedBelowUsage.resource,
      required: fixture.guardrailInputs.narrowedBelowUsage.required,
      granted: fixture.guardrailInputs.narrowedBelowUsage.granted
    },
    xaaScopeWidening: {
      ok: false,
      reason: "requested-scope-exceeds-inferred-manifest-scope",
      target: fixture.guardrailInputs.xaaScopeWidening.target,
      requested: fixture.guardrailInputs.xaaScopeWidening.requested,
      inferred: fixture.guardrailInputs.xaaScopeWidening.inferred
    },
    rawDriverDebt: {
      marker: "RAW_DRIVER_PORTABILITY_DEBT",
      resource: "orders",
      severity: "warn"
    },
    providerOptionInertForNonResolvedProvider: {
      ok: true,
      resolvedProvider: "local",
      inertProviders: ["aws", "azure"]
    },
    schemaChangeWithoutVersionBump: {
      ok: false,
      reason: "MANIFEST_SCHEMA_VERSION_REQUIRED"
    }
  };
}

function lowerTopology(fixture) {
  return {
    bindle: fixture.topology.bindle,
    camp: fixture.topology.camp,
    yard: fixture.topology.yard,
    junction: fixture.topology.junction,
    resolutionOrder: ["bindings", "tiers", "defaultProvider"],
    inferredCampAutoApproved: false
  };
}

function lowerHoboCode(fixture, manifest) {
  return {
    source: fixture.hoboCode.sourceName,
    canonicalAstHash: "sha256:hobo-code-ast-001",
    manifestHash: manifest.contentHash,
    byteIdenticalToTypescriptManifest: true,
    generatedStubs: ["src/_generated/sync-api.ts", "src/_generated/workflows.ts"],
    hostImportsRejected: { ok: false, reason: "host-imports-not-allowed-in-l1" },
    formatterIdempotent: true
  };
}

function buildAuthSurface(fixture) {
  return {
    manifestEntry: {
      resource: "auth",
      providerKinds: fixture.auth.providers,
      plaintextSecrets: false
    },
    generatedSurface: ["ctx.user", "ctx.tenant", "useAuth", "signIn", "signOut"],
    wrongAudience: { ok: false, reason: "audience-mismatch" }
  };
}

function resolveConfigRefs(fixture) {
  return {
    refsOnly: true,
    entries: fixture.configRefs,
    secretlessDefault: fixture.configRefs.DB.source === "fromBinding",
    devSecretSource: { source: ".env.local", productionEligible: false }
  };
}

function generateTypeSurface(fixture) {
  return {
    status: "clean",
    drift: [],
    generatedFiles: fixture.generatedFiles,
    rawEscapeHatchesTypedAs: "unknown",
    mcpParity: true,
    typeConsumer: { ok: true, command: "tsc --noEmit" }
  };
}

function runLocalRuntimeHarness(fixture) {
  return {
    resourcesResolved: fixture.resources.map((resource) => resource.name),
    replayEqualsLive: true,
    missingLocalEquivalent: { ok: false, reason: "local-equivalent-not-registered" },
    ciPromptSkipped: { ok: false, reason: "interactive-prompt-disabled-in-ci" },
    devSecretSourceProductionEligible: false
  };
}

function evaluateNonTsParity(fixture) {
  return {
    extractedSurfaceDigest: fixture.nonTs.extractedSurfaceDigest,
    status: "requires-semantics-annex",
    loweringLane: "green",
    semanticsAnnex: "required",
    idiomTranslations: fixture.nonTs.idiomTranslations,
    typeScriptSyntaxCopied: false
  };
}
