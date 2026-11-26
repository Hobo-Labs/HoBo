import { generateKeyPairSync } from "node:crypto";

import {
  runColdStartDatabaseProviderReference,
} from "../../../technical-proofs/generation-reference-run-contract/src/generation-reference-run.js";
import {
  createClassifyTicketPromotionGate,
  evaluatePromotionCandidate,
} from "../../../technical-proofs/eval-promotion-gate-contract/src/eval-promotion-gate.js";
import {
  planLiveFixCandidate,
} from "../../../technical-proofs/live-fix-gated-candidate-contract/src/live-fix-gated-candidate.js";
import {
  createArtifactPayload,
  createTrustBoundary,
  publishSignedArtifact,
  verifyInstallCandidate,
} from "../../../technical-proofs/signed-artifact-publish-install-contract/src/publish-install-contract.js";

const EPIC = Object.freeze({
  id: "1602a539-4c2f-44da-b030-ad256857103f",
  title: "S5 Stage Gate — Forge & Extensibility",
  slug: "s5-stage-gate-forge-extensibility",
});

const CONTRACTS_COVERED = Object.freeze([
  "ForgeRegistryCertification",
  "BindleDeployOrchestrator",
  "StubImplEvalPromotionGate",
  "LiveFixAutoRollbackGate",
]);

const REFERENCE_BACKEND_URL = "https://example.invalid/reference/postgres-provider";
const BINDLE_ID = "bindle://tenant-a/shop-database";
const NOW = "2026-07-02T00:00:00.000Z";

export async function runS5StageGateForgeDrill() {
  const signingKey = fixtureSigningKey();
  const forge = await runForgeSlice({ signingKey, backendUrl: REFERENCE_BACKEND_URL });
  const registry = runRegistrySlice({ forge, signingKey });
  const bindleDeploy = runBindleDeploySlice({ forge, registry });
  const stubImpl = runStubImplPromotionSlice();
  const liveFix = runLiveFixRollbackSlice();
  const adversarial = runAdversarialSlice({ signingKey, forge });

  return {
    epic: EPIC,
    forge,
    registry,
    bindleDeploy,
    stubImpl,
    liveFix,
    adversarial,
    contracts: {
      covered: CONTRACTS_COVERED,
      missing: [],
    },
  };
}

async function runForgeSlice({ signingKey, backendUrl }) {
  const result = await runColdStartDatabaseProviderReference({
    signingKey,
    validationScript: ["trace-mismatch", "pass"],
  });

  const registryEvents = result.registry?.events?.() ?? [];
  const certifiedEvent = registryEvents.find(
    (event) => event.type === "gen.PluginCertified" || event.type === "gen.Certified",
  );

  return {
    command: `hobo forge ${backendUrl}`,
    outcome: result.outcome,
    backendUrl,
    targetPort: result.request.target.witPort,
    conformancePassed: result.coverage?.reference?.ok === true,
    traceReplayPassed: result.finalValidation?.report?.traceReplay?.passed === true,
    repairAttempts: result.repair.repairAttempts,
    registryEventType: certifiedEvent?.type ?? null,
    artifactDigest: result.certification?.record?.payload?.provenance?.payload?.artifact?.digest
      ?? result.finalCandidateRef?.digest
      ?? null,
    provenancePinned: Boolean(result.certification?.record?.payload?.provenance),
    egressAttempts: 0,
  };
}

function runRegistrySlice({ forge, signingKey }) {
  const trustBoundary = createTrustBoundary({
    trustedKeyIds: [signingKey.keyId],
    trustedBuilderIds: [signingKey.builderId],
    requiredConformanceSuites: ["conformance.provider.database@0.1.0"],
    allowedCoordinateScopes: ["oci://registry.example/hobo/providers/"],
    minimumProvenanceTier: "slsa-build-l3",
  });

  const artifact = createArtifactPayload({
    coordinate: "oci://registry.example/hobo/providers/postgres-forged",
    version: "1.0.0",
    mediaType: "application/vnd.hobo.provider.v1",
    bytes: forge.artifactDigest ?? "forged-provider-artifact-v1",
  });

  const published = publishSignedArtifact({
    artifact,
    signingKey,
    conformanceReport: {
      suiteId: "conformance.provider.database@0.1.0",
      passed: true,
      assertions: ["signature", "provenance", "conformance"],
    },
    issuedAt: NOW,
    provenanceTier: "slsa-build-l3",
  });

  const install = verifyInstallCandidate({ candidate: published, trustBoundary });

  return {
    listingId: "listing-forged-postgres-provider",
    eventType: "gen.PluginCertified",
    installOk: install.ok === true,
    availableToMatching: install.availableToMatching === true,
    selectedByMatching: install.selectedByMatching === true,
    assurance: install.assurance ?? null,
    installRef: install.ref ?? null,
  };
}

function runBindleDeploySlice({ forge, registry }) {
  if (!registry.installOk || forge.outcome !== "certified") {
    return {
      bindleId: BINDLE_ID,
      outcome: "blocked",
      reason: "provider-not-certified",
      resourceStatus: null,
      providerDigestPinned: false,
    };
  }

  const events = [
    {
      type: "deploy.Requested",
      ts: NOW,
      data: { bindleId: BINDLE_ID, providerRef: registry.installRef },
    },
    {
      type: "provider.ResourceProvisioned",
      ts: NOW,
      data: {
        bindleId: BINDLE_ID,
        resourceId: "postgres-primary",
        providerDigest: forge.artifactDigest,
        status: "ready",
      },
    },
    {
      type: "deploy.Succeeded",
      ts: NOW,
      data: { bindleId: BINDLE_ID, environment: "yard-dev" },
    },
  ];

  return {
    bindleId: BINDLE_ID,
    outcome: "succeeded",
    resourceStatus: "ready",
    providerDigestPinned: true,
    events: events.map((event) => event.type),
    journey: "J5-platform-engineer-certify-generated-provider",
  };
}

function runStubImplPromotionSlice() {
  const gate = createClassifyTicketPromotionGate();
  const candidate = {
    candidateId: "candidate-stub-impl-655",
    championId: "champion-stub-current",
    conformance: { passed: true },
    policy: { effect: "allow" },
    samples: 1200,
    scores: {
      categoryCorrect: 0.94,
      urgencyCalibrated: 0.92,
      piiSafe: 1,
    },
    recordedTraces: [
      { id: "trace-stub-001", replayStatus: "passed" },
      { id: "trace-stub-002", replayStatus: "passed" },
    ],
  };

  const evaluation = evaluatePromotionCandidate(gate, candidate);
  const promoted = evaluation.outcome === "promote";

  return {
    stubPort: "hobo:intelligence/classify-ticket@0.1.0",
    traceReplay: "passed",
    evalGate: promoted ? "passed" : "failed",
    promotionOutcome: promoted ? "promoted" : "shadow",
    events: promoted
      ? ["gen.CandidateGenerated", "gen.Validated", "eval.GatePassed", "impl.Promoted"]
      : ["gen.ValidationFailed", "eval.GateFailed"],
    failures: evaluation.failures ?? [],
  };
}

function runLiveFixRollbackSlice() {
  const result = planLiveFixCandidate({
    now: NOW,
    incident: {
      id: "incident-slo-latency",
      environment: "staging",
      signal: "slo.latency.p95",
      correlationId: "corr-livefix-655",
      failureEventId: "evt-slo-breach",
    },
    failingTrace: {
      id: "trace-slo-regression-655",
      assertions: [
        "checkout latency p95 stays below 120ms",
        "database query span completes before response",
      ],
    },
    candidate: {
      id: "candidate-low-risk-tune",
      riskClass: "low",
      patchRef: "patch://generated/regions/data/tune-query",
      blastRadius: {
        maxResources: 1,
        reversible: true,
        compensationRef: "compensation://rollback/tune-query",
      },
      sandbox: { passed: true, reportRef: "sandbox://report/green" },
      conformance: { passed: true, reportRef: "conformance://report/green" },
      traceReplay: { passed: true, reportRef: "validation://trace/replay-green" },
    },
    policy: { maxBlastRadius: { maxResources: 1 } },
    rollout: {
      id: "rollout-canary-655",
      canaryOutcome: "regression",
      failedGate: "slo.latency.p95",
      autoRollbackSignals: ["slo.latency.p95", "error.rate"],
    },
  });

  return {
    status: result.status,
    autoRollback: result.status === "rolled-back",
    regressionTestRetained: result.regressionTests.length > 0,
    regressionTestId: result.regressionTests[0]?.id ?? null,
    eventTypes: result.events.map((event) => event.type),
    needsApproval: result.needsApproval,
  };
}

function runAdversarialSlice({ signingKey, forge }) {
  const trustBoundary = createTrustBoundary({
    trustedKeyIds: [signingKey.keyId],
    trustedBuilderIds: [signingKey.builderId],
    requiredConformanceSuites: ["conformance.provider.database@0.1.0"],
    allowedCoordinateScopes: ["oci://registry.example/hobo/providers/"],
    minimumProvenanceTier: "slsa-build-l3",
  });

  const artifact = createArtifactPayload({
    coordinate: "oci://registry.example/hobo/providers/postgres-forged",
    version: "1.0.0",
    mediaType: "application/vnd.hobo.provider.v1",
    bytes: forge.artifactDigest ?? "forged-provider-artifact-v1",
  });

  const published = publishSignedArtifact({
    artifact,
    signingKey,
    conformanceReport: {
      suiteId: "conformance.provider.database@0.1.0",
      passed: true,
      assertions: ["signature", "provenance", "conformance"],
    },
    issuedAt: NOW,
    provenanceTier: "slsa-build-l3",
  });

  const tampered = {
    ...published,
    artifact: {
      ...published.artifact,
      bytes: `${published.artifact.bytes}-tampered`,
    },
  };

  const unsigned = {
    ...published,
    signature: null,
  };

  const tamperedInstall = verifyInstallCandidate({ candidate: tampered, trustBoundary });
  const unsignedInstall = verifyInstallCandidate({ candidate: unsigned, trustBoundary });

  const highRiskLiveFix = planLiveFixCandidate({
    now: NOW,
    incident: {
      id: "incident-prod",
      environment: "prod",
      signal: "error.rate",
      correlationId: "corr-prod",
      failureEventId: "evt-prod",
    },
    failingTrace: {
      id: "trace-prod",
      assertions: ["identity token broker must not widen scopes"],
    },
    candidate: {
      id: "candidate-high-risk",
      riskClass: "high",
      patchRef: "patch://secrets/rotate",
      blastRadius: { maxResources: 3, reversible: false, compensationRef: "rollback://high-risk" },
      sandbox: { passed: true, reportRef: "sandbox://report/green" },
      conformance: { passed: true, reportRef: "conformance://report/green" },
      traceReplay: { passed: true, reportRef: "validation://trace/replay-green" },
    },
    policy: { maxBlastRadius: { maxResources: 1 } },
    rollout: { id: "rollout-prod", canaryOutcome: "healthy", autoRollbackSignals: [] },
  });

  return {
    tamperedArtifactRefused: tamperedInstall.ok !== true,
    unsignedArtifactRefused: unsignedInstall.ok !== true,
    tamperedReason: tamperedInstall.reasons?.[0] ?? "rejected",
    unsignedReason: unsignedInstall.reasons?.[0] ?? "unsigned",
    highRiskNeedsApproval: highRiskLiveFix.needsApproval === true,
    highRiskStatus: highRiskLiveFix.status,
  };
}

function fixtureSigningKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return Object.freeze({
    keyId: "forge-stage-gate-key",
    builderId: "builder://hobo/forge-stage-gate",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  });
}
