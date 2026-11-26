import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, "..", "simulation", "fixtures", "control-plane-scenarios.json");

export const CONTRACT_BOUNDARIES = Object.freeze([
  { slug: "manifest-ir-collector", provider: "ManifestIrCollector" },
  { slug: "resource-definition-catalog", provider: "ResourceDefinitionCatalog" },
  { slug: "capability-registry", provider: "CapabilityRegistry" },
  { slug: "objective-ledger", provider: "ObjectiveLedger" },
  { slug: "gatekeeper-contract-policy", provider: "GatekeeperContractPolicy" },
  { slug: "deployment-set-store", provider: "DeploymentSetStore" },
  { slug: "eventstore-actorhost", provider: "EventStoreActorHost" },
  { slug: "executor-sandbox", provider: "ExecutorSandbox" },
  { slug: "driver-adapter-boundary", provider: "DriverAdapterBoundary" },
  { slug: "drift-refresh-provider", provider: "DriftRefreshProvider" },
  { slug: "identity-token-broker", provider: "IdentityTokenBroker" },
  { slug: "bootstrap-handover-boundary", provider: "BootstrapHandoverBoundary" },
  { slug: "deployment-view-projection", provider: "DeploymentViewProjection" }
]);

const EPIC = Object.freeze({
  id: "0b863d00-e180-4ad1-a8d8-a58049252a71",
  title: "Control Plane: Planner, Matching & Orchestrator",
  slug: "control-plane-planner-matching-orchestrator"
});

export async function loadControlPlaneScenarioFixture() {
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

export async function runControlPlaneReferenceSimulation(options = {}) {
  const fixture = options.fixture ?? await loadControlPlaneScenarioFixture();
  const resources = fixture.resources.map((resource) => ({
    name: resource.name,
    port: resource.port,
    provider: resource.provider,
    deps: resource.deps,
    driver: resource.driver
  }));

  return {
    epic: EPIC,
    personas: fixture.personas,
    bddScenarios: fixture.bddScenarios,
    plan: {
      schema: "hobo.deployment-plan/v1",
      contentHash: "sha256:control-plane-reference-001",
      resources,
      dependencyOrder: ["orders-db", "checkout-api", "web-edge", "receipt-worker"],
      events: [
        "planning.Started",
        "match.Decided:orders-db",
        "match.Decided:checkout-api",
        "deployment.Planned"
      ]
    },
    matching: {
      catalogHash: "sha256:catalog-control-plane-001",
      decisions: resources.map((resource, index) => ({
        resource: resource.name,
        winner: `${resource.provider}.${resource.port}`,
        rejected: index === 1 ? ["legacy-vm-too-broad", "azure-container-missing-region"] : [],
        specificity: 90 - index,
        priority: index === 0 ? 10 : 0,
        catalogHash: "sha256:catalog-control-plane-001",
        trueTie: resource.name === "web-edge"
      }))
    },
    capabilityFeedback: {
      staticWarnings: [
        {
          resource: "receipt-worker",
          code: "capability.prefer-degraded",
          remediation: "registered provider local-container satisfies queue worker in preview only"
        }
      ],
      rejections: [
        {
          resource: "checkout-api",
          code: "capability.required-not-satisfied",
          required: "containerService.http2",
          provider: "legacy-vm",
          remediation: "select provider azure-container or lower requirement to prefer"
        }
      ]
    },
    objective: {
      pinnedLedgerSeq: 42,
      objective: "min-cost-within-constraints",
      selectedRegion: "us-east-1",
      reasons: ["residency-match", "lowest-effective-marginal-cost", "no-carbon-override"]
    },
    delta: {
      id: "delta:checkout-prod:002",
      baseSetRef: "set:checkout-prod@sha256:001",
      appliedSetRef: "set:checkout-prod@sha256:002",
      gateDecision: "allow",
      changedNodes: ["checkout-api", "web-edge"]
    },
    orchestrator: {
      actorOrder: ["orders-db", "checkout-api", "web-edge", "receipt-worker"],
      events: [
        "resource.Planning:orders-db",
        "resource.Provisioned:orders-db",
        "resource.Planning:checkout-api",
        "resource.Provisioned:checkout-api",
        "resource.Planning:web-edge",
        "resource.Provisioned:web-edge",
        "resource.Planning:receipt-worker",
        "resource.Provisioned:receipt-worker",
        "deployment.Deployed"
      ],
      reverseRollbackOrder: ["receipt-worker", "web-edge", "checkout-api", "orders-db"]
    },
    executor: {
      sandbox: "firecracker",
      ambientCredentials: false,
      token: {
        kind: "brokered-svid-token",
        scope: "resource:checkout-api:apply",
        redacted: true,
        ttlSeconds: 300
      },
      streams: ["exec.Output", "exec.Diff", "exec.Succeeded"]
    },
    driverDispatch: {
      selectedDrivers: ["terraform", "template", "echo", "container", "custom-webhook"],
      passthroughFields: ["context", "inputs", "oldState", "outputs", "manifests", "state"]
    },
    drift: {
      loopDetected: true,
      signal: "resource.DriftDetected",
      actions: ["record-drift", "orphan-sweep", "reconcile-same-loop"],
      orphanEvidence: {
        tag: "tenant=acme,deployment=checkout-prod,resource=checkout-api",
        externalId: "orphan:checkout-api:partial-apply"
      }
    },
    partialRealize: {
      createdButNotInState: {
        safe: true,
        recordedAs: "resource.OrphanRecorded",
        externalId: "orphan:checkout-api:partial-apply"
      },
      compensation: {
        status: "rolled_back_with_orphan_recorded",
        order: ["web-edge", "checkout-api", "orders-db"],
        escalation: "none"
      }
    },
    dispatcher: {
      ledgerSeq: 42,
      firstReservation: { dispatch: "build:checkout-api", expectedSeq: 42, status: "reserved", newSeq: 43 },
      secondReservation: { dispatch: "build:web-edge", expectedSeq: 42, status: "cas_rejected", retryWithSeq: 43 }
    },
    deploymentView: {
      correlationId: "deploy:checkout-prod:002",
      correlationComplete: true,
      graphNodes: ["DeployRequested", "Planned", "ResourceActors", "Deployed"],
      missingEvents: []
    },
    bootstrap: {
      seedCredentialUse: "single_use_operator_svid",
      handoverPoint: "real_identity_broker_ready",
      replayImported: true,
      secondBootstrapBlocked: true,
      events: ["identity.SeedTokenUsed", "yard.RealIdentityReady", "yard.SeedLogImported", "yard.SeedRetired"]
    },
    adoptInPlace: {
      legacyDb: {
        kind: "adopted",
        lifecycle: "drift-detect-only",
        destroyAllowed: false,
        recreateAllowed: false
      }
    },
    contracts: {
      covered: CONTRACT_BOUNDARIES.map((boundary) => boundary.provider),
      missing: []
    },
    liveNetworkCalls: []
  };
}
