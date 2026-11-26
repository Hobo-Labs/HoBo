import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, "..", "simulation", "fixtures", "providers-reference-scenarios.json");

export const CONTRACT_BOUNDARIES = Object.freeze([
  { slug: "provider-package-registry", provider: "ProviderPackageRegistry" },
  { slug: "provider-conformance-gate", provider: "ProviderConformanceGate" },
  { slug: "equivalence-resolver-catalog", provider: "EquivalenceResolverCatalog" },
  { slug: "capability-manifest-registry", provider: "CapabilityManifestRegistry" },
  { slug: "realize-emission-boundary", provider: "RealizeEmissionBoundary" },
  { slug: "portability-report-gate", provider: "PortabilityReportGate" },
  { slug: "iac-backend-adapter", provider: "IacBackendAdapter" },
  { slug: "build-provider-adapter", provider: "BuildProviderAdapter" },
  { slug: "local-container-provider", provider: "LocalContainerProvider" },
  { slug: "concrete-cloud-provider-matrix", provider: "ConcreteCloudProviderMatrix" },
  { slug: "driver-taxonomy-adapter", provider: "DriverTaxonomyAdapter" },
  { slug: "drift-import-refresh-boundary", provider: "DriftImportRefreshBoundary" },
  { slug: "generation-certification-sandbox", provider: "GenerationCertificationSandbox" },
  { slug: "resource-pack-distribution", provider: "ResourcePackDistribution" },
  { slug: "execution-host-dispatch", provider: "ExecutionHostDispatch" }
]);

const EPIC = Object.freeze({
  id: "daa89960-b663-42f4-8cca-67a90d979beb",
  title: "Providers, IaC & Build Adapters",
  slug: "providers-iac-build-adapters"
});

export async function loadProvidersScenarioFixture() {
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

export async function runProvidersReferenceSimulation(options = {}) {
  const fixture = options.fixture ?? await loadProvidersScenarioFixture();
  const providers = fixture.providers.map((provider) => ({
    id: provider.id,
    family: provider.family,
    capabilities: provider.capabilities,
    iacAdapters: provider.iacAdapters,
    conformance: "passed"
  }));

  return {
    epic: EPIC,
    personas: fixture.personas,
    bddScenarios: fixture.bddScenarios,
    childPocs: fixture.childPocs,
    providerCatalog: {
      providers,
      defaults: fixture.defaultDefinitions.map((definition) => ({
        ...definition,
        source: "provider-owned"
      })),
      registeredEvents: providers.map((provider) => `provider.Registered:${provider.id}`)
    },
    equivalenceResolver: {
      catalogHash: "sha256:providers-catalog-001",
      decisions: fixture.equivalenceDecisions,
      unsatisfiedRequire: {
        request: "database.postgres.managed.ha.vector",
        rejectedProvider: "hetzner",
        reason: "required capability vector is unavailable",
        remediation: "select aws, azure, gcp, or cloudflare-neon"
      },
      preferWarnings: [
        {
          provider: "hetzner",
          requested: "database.postgres.managed",
          acceptedAs: "database.postgres.containerized",
          warning: "managed database degraded to container-backed postgres"
        }
      ]
    },
    conformance: {
      suiteVersion: "provider-capability@0.1.0",
      claimedPortsCovered: true,
      reports: providers.map((provider) => ({
        provider: provider.id,
        status: "passed",
        claimedPorts: provider.capabilities
      })),
      maliciousClaimsRejected: ["forged-report", "undeclared-egress", "unsupported-port"]
    },
    capabilityManifest: {
      schema: "hobo.capability-manifest/v1",
      includes: ["capabilities", "auth.json", "cost.json", "regions", "conformance"],
      brokeredAuthOnly: true,
      staticKeyFallbackBounded: true
    },
    realize: {
      pipeline: ["realize", "build", "preview", "apply", "refresh"],
      iacProgram: {
        kind: "hobo.iac-program/v1",
        resource: "shop-api",
        provider: "aws",
        driver: "pulumi",
        buildSpecRef: "build:shop-api:wasm",
        links: ["component:shop-api imports wasi:sql/postgres -> provider:aws-rds"]
      },
      buildSpec: {
        kind: "hobo.build-spec/v1",
        engines: ["build-wasm", "build-dagger", "build-packer", "build-firecracker", "build-vagrant"]
      },
      outputsToBindings: true,
      liveProviderCalls: []
    },
    iacAdapters: {
      pulumi: { previewThenApply: true, shellOut: false, stateUnit: "per-resource-stack" },
      opentofu: { binaryWrapped: true, stateBackends: ["s3-compatible", "yard-object-store"] },
      crossplane: { controllerDriven: true, substrate: "kubernetes" },
      cdktf: { mode: "import-only", authorsNewInfra: false }
    },
    buildAdapters: {
      imageRefs: [
        "oci://registry.local/shop-api:wasm",
        "oci://registry.local/shop-worker:container",
        "oci://registry.local/shop-vm:packer",
        "oci://registry.local/shop-sandbox:firecracker-rootfs"
      ],
      sourceToWasm: true,
      containerFallback: true,
      vmParity: true
    },
    driverAdapters: {
      selected: ["terraform", "template", "echo", "container", "custom-webhook"],
      echoReadOnly: true,
      customWebhookSignedBySvid: true,
      sandbox: "firecracker"
    },
    localContainerProvider: {
      zeroInfraFloor: true,
      offlineDev: true,
      conformanceTag: "local",
      liveNetworkRequired: false
    },
    concreteProviders: {
      heavyweight: ["aws", "azure", "gcp"],
      edge: ["cloudflare", "vercel"],
      selfHost: ["hetzner", "kubernetes"],
      globalVm: ["fly"],
      everyClaimedPortConformanceGated: true
    },
    drift: {
      detected: true,
      source: "refresh",
      actions: ["record-drift", "orphan-sweep", "reconcile-same-loop"],
      falseDriftRejected: true
    },
    partialApply: {
      createdButNotInState: {
        recorded: true,
        externalId: "orphan:shop-api:partial-apply",
        tags: ["tenant=acme", "deployment=shop-prod", "resource=shop-api"]
      },
      compensation: {
        status: "safe_rollback_requires_orphan_sweep",
        order: ["shop-web", "shop-api", "shop-db"],
        incidentEscalation: "only_if_orphan_identity_unknown"
      }
    },
    adoptImport: {
      externalResourceKind: "external",
      adoptedResourceKind: "adopted",
      cdktfImportOnly: true,
      destroyOnImportAllowed: false,
      driftDetectOnly: true
    },
    maliciousProvider: {
      contained: true,
      forgedReportAccepted: false,
      egressAllowed: false,
      sandbox: "no-egress-firecracker",
      policyDecision: "deny"
    },
    portabilityReport: {
      canDeploy: false,
      lockInEntries: [
        { resource: "shop-db", reason: "provider-specific rds storage option" },
        { resource: "shop-edge", reason: "provider-native workers runtime" },
        { resource: "legacy-db", reason: "adopted external resource" }
      ],
      inertOptionsChecked: true
    },
    generation: {
      referenceRun: {
        target: "database-provider",
        status: "certified",
        reproducibleDigest: "sha256:generated-provider-001",
        conformanceSuite: "provider-capability@0.1.0"
      },
      repairBudget: {
        maxAttempts: 3,
        exhaustedBehavior: "gen.NeedsHuman"
      },
      materialSanitized: true,
      provenanceSigned: true
    },
    resourcePack: {
      artifact: "oci://registry.local/resource-packs/aws-data-tier:0.1.0",
      signatureVerified: true,
      conformanceReports: [
        { provider: "aws", status: "passed" },
        { provider: "azure", status: "passed" },
        { provider: "local-container", status: "passed" }
      ],
      airGapBundleCompatible: true
    },
    executionHosts: {
      candidates: ["self-hosted", "github", "blacksmith", "depot"],
      creditLedgerSeq: 77,
      dispatchDecision: "self-hosted-build-machine",
      reason: "lowest marginal cost with private-network access"
    },
    multiCloudShop: {
      bindleSourceDigest: "sha256:shop-bindle-unchanged",
      targets: ["aws", "azure"],
      sameTopology: true,
      sameBindings: true,
      providerOptionsLeaked: false,
      unsatisfiedRequireRejected: true,
      campChecksRun: ["aws-prod", "azure-prod"]
    },
    contracts: {
      covered: CONTRACT_BOUNDARIES.map((boundary) => boundary.provider),
      missing: []
    },
    liveNetworkCalls: []
  };
}
