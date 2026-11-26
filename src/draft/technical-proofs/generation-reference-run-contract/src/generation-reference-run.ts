import { isJsonString } from "./json.js";
import { runBoundedRepairLoop } from "../../generation-bounded-repair-loop-contract/src/bounded-repair-loop.js";
import {
  createGenerationCertifyStage,
  createInMemoryCertificationRegistry
} from "../../generation-certify-stage-contract/src/certify-stage.js";
import { fillGenerationCandidate } from "../../generation-llm-fill-contract/src/fill.js";
import { validateGenRequest } from "../../generation-pipeline-io-contract/src/contract.js";
import { scaffoldGenerationRequest } from "../../generation-scaffold-stage-contract/src/scaffold.js";
import { runValidationStage } from "../../generation-validation-stage-contract/src/validation-stage.js";
import {
  createReferenceLocalProvider,
  runProviderCapabilitySuites
} from "../../provider-capability-conformance-suites/src/provider-capability-conformance.js";
import { contentDigest } from "../../slsa-provenance-certification-contract/src/provenance.js";

export const GENERATION_REFERENCE_REPAIR_BUDGET = 2;

const targetPort = "hobo:database/postgres@0.1.0";
const suiteId = "conformance.provider.database@0.1.0";
const fixedTs = "2026-06-27T19:45:00.000Z";
const generationConfig = Object.freeze({
  temperature: 0,
  topP: 1
});
const model = Object.freeze({
  provider: "self-hosted",
  id: "self-hosted/qwen3-coder",
  digest: contentDigest({
    provider: "self-hosted",
    id: "qwen3-coder",
    weights: "pinned",
    generationConfig
  })
});

const requiredReferenceChecks = Object.freeze([
  "database.local.provision-connects",
  "database.local.honors-require-prefer",
  "database.local.refresh-reports-drift",
  "database.local.destroy-cleans-state"
]);
const requiredProductionChecks = Object.freeze([
  ...requiredReferenceChecks,
  "database.camp.real-provider-drift",
  "database.camp.iam-mtls-quota-evidence"
]);

export function buildColdStartDatabaseProviderRequest(overrides = {}) {
  return validateGenRequest({
    schema: "hobo.gen.request/v1",
    requestId: "hobo-348-database-provider-reference",
    artifactKind: "provider",
    target: {
      witPort: targetPort
    },
    capabilityManifestRef: digestRef("capability-manifest", {
      provider: "@acme/provider-postgres",
      targetPort,
      claims: ["database"]
    }),
    authoritativeRefs: [
      {
        kind: "wit",
        ref: "wit://hobo/database@0.1.0"
      },
      {
        kind: "conformance-suite",
        suiteId,
        ref: "oci://registry.example/hobo/conformance/database@sha256:348"
      }
    ],
    materialRefs: [
      {
        kind: "provider-docs",
        ref: "https://example.invalid/postgres/provider-docs",
        trusted: false,
        sanitized: true
      },
      {
        kind: "openapi",
        ref: "https://example.invalid/postgres/openapi.json",
        trusted: false,
        sanitized: true
      },
      {
        kind: "recorded-traces",
        ref: "oci://registry.example/hobo/traces/database-reference@sha256:348",
        trusted: false,
        sanitized: true
      }
    ],
    ...overrides
  });
}

export async function runColdStartDatabaseProviderReference({
  signingKey,
  requestOverrides,
  validationScript = ["pass"],
  seed = "seed-hobo-348",
  repairBudget = GENERATION_REFERENCE_REPAIR_BUDGET,
  coverageTags = ["local", "camp"],
  campEvidence = "real",
  materialProfile = "manifest-and-docs"
} = {}) {
  assertSigningKey(signingKey);
  assertPinnedInputs({ seed });

  const request = buildColdStartDatabaseProviderRequest(requestOverrides);
  const scaffold = scaffoldGenerationRequest(request, { seq: 2, ts: fixedTs });
  if (scaffold.status !== "candidate-generated") {
    return needsHumanResult({ request, scaffold, materialProfile });
  }

  const fill = fillGenerationCandidate(request, scaffold.candidate, {
    seq: 3,
    ts: fixedTs,
    seed,
    model
  });
  const provider = createReferenceLocalProvider({
    claimedCapabilities: ["database"],
    campBehavior: "pass"
  });
  const suiteRun = runProviderCapabilitySuites(provider, {
    capabilities: ["database"],
    tags: coverageTags
  });
  const coverage = {
    reference: assessCoverage({
      profile: "reference",
      suiteRun,
      campEvidence
    }),
    production: assessCoverage({
      profile: "production",
      suiteRun,
      campEvidence
    })
  };

  const validations = [];
  const remainingScript = [...validationScript];
  const repair = await runBoundedRepairLoop({
    request,
    initialCandidateRef: fill.candidate.ref,
    maxRepairAttempts: repairBudget,
    validateCandidate: async ({ candidateRef, iteration }) => {
      const mode = remainingScript.shift() ?? "pass";
      const validation = await validateCandidate({
        request,
        candidateRef,
        mode,
        seq: 10 + iteration * 2
      });
      validations.push(validation);

      if (validation.report.passed) {
        return {
          passed: true,
          candidateRef,
          validationReportRef: validation.report.ref
        };
      }

      return {
        passed: false,
        candidateRef,
        validationReportRef: validation.report.ref,
        failingAssertions: validation.event.data.failingAssertions
      };
    },
    regenerateCandidate: async ({ previousCandidateRef, failingAssertions, iteration }) => ({
      candidateRef: repairedCandidateRef({
        request,
        seed,
        previousCandidateRef,
        failingAssertions,
        iteration
      })
    }),
    seqStart: 4,
    ts: fixedTs
  });

  const finalValidation = validations.at(-1) ?? null;
  const finalCandidateRef =
    finalValidation?.report.candidateRef ?? repair.finalEvent.data.candidateRef ?? fill.candidate.ref;
  const registry = createInMemoryCertificationRegistry({
    trustedKeys: { [signingKey.keyId]: signingKey.publicKeyPem }
  });

  if (repair.outcome !== "converged" || !coverage.reference.ok || !coverage.production.ok) {
    return {
      outcome: repair.outcome === "converged" ? "needs-human" : repair.outcome,
      materialProfile,
      request,
      scaffold,
      fill,
      repair,
      validations,
      finalValidation,
      finalCandidateRef,
      coverage,
      certification: null,
      registry,
      stageResults: stageResults({ certified: false })
    };
  }

  const validationReport = certificationValidationReport({
    request,
    validationReport: finalValidation.report
  });
  const conformanceReport = certificationConformanceReport({
    request,
    suiteRun
  });
  const certification = createGenerationCertifyStage({ registry, signingKey }).certify(
    certificationInput({
      request,
      fillCandidate: fill.candidate,
      candidateRef: finalCandidateRef,
      validationReport,
      conformanceReport,
      seed
    })
  );

  return {
    outcome: certification.ok ? "certified" : "needs-human",
    materialProfile,
    request,
    scaffold,
    fill,
    repair,
    validations,
    finalValidation,
    finalCandidateRef,
    coverage,
    certification,
    registry,
    stageResults: stageResults({ certified: certification.ok })
  };
}

export function runNonConvergingDatabaseProviderReference(options = {}) {
  return runColdStartDatabaseProviderReference({
    ...options,
    validationScript: ["trace-mismatch", "conformance-mismatch", "trace-mismatch"]
  });
}

export function runColdStartDocsOnlyReference(options = {}) {
  return runColdStartDatabaseProviderReference({
    ...options,
    materialProfile: "docs-only-no-manifest",
    requestOverrides: {
      capabilityManifestRef: digestRef("capability-manifest", {
        provider: "unknown-docs-only",
        inferredCapability: "database",
        source: "docs-openapi-only"
      }),
      materialRefs: [
        {
          kind: "provider-docs",
          ref: "https://example.invalid/postgres/provider-docs",
          trusted: false,
          sanitized: true
        },
        {
          kind: "openapi",
          ref: "https://example.invalid/postgres/openapi.json",
          trusted: false,
          sanitized: true
        }
      ],
      ...(options.requestOverrides )
    }
  });
}

export function assessCoverage({ profile, suiteRun, campEvidence = "none" }) {
  const required = profile === "production" ? requiredProductionChecks : requiredReferenceChecks;
  const observed = new Map((suiteRun?.checks ?? []).map((check) => [check.checkId, check]));
  const reasons = [];

  for (const checkId of required) {
    const check = observed.get(checkId);
    if (!check) {
      reasons.push(`missing required coverage ${checkId}`);
      continue;
    }
    if (check.status !== "pass") {
      reasons.push(`failed required coverage ${checkId}`);
    }
  }

  for (const failure of suiteRun?.failures ?? []) {
    reasons.push(`failed ${failure.checkId}: ${failure.message}`);
  }
  if (profile === "production" && campEvidence !== "real") {
    reasons.push("production coverage requires real Camp evidence");
  }

  return Object.freeze({
    ok: reasons.length === 0 && suiteRun?.status === "pass",
    profile,
    capability: "database",
    requiredChecks: required,
    observedChecks: Object.freeze([...observed.keys()].sort()),
    reasons: Object.freeze(reasons)
  });
}

async function validateCandidate({ request, candidateRef, mode, seq }) {
  return runValidationStage({
    request,
    candidate: {
      requestId: request.requestId,
      artifactKind: request.artifactKind,
      targetWitPort: targetPort,
      conformanceSuiteId: suiteId,
      ref: candidateRef
    },
    sandboxProfile: validationSandboxProfile(),
    runConformance: async () => conformanceResultFor(mode),
    replayTraces: async () => traceReplayFor(mode),
    seq,
    ts: fixedTs
  });
}

function conformanceResultFor(mode) {
  const wrongPort = mode === "wrong-port";
  const conformanceFailed = mode === "conformance-mismatch" || wrongPort;
  return {
    suiteId,
    targetPort,
    passed: !conformanceFailed,
    assertions: [
      { id: "contract.connects", passed: true },
      { id: "contract.destroy.clean", passed: true },
      {
        id: "contract.require-miss",
        passed: mode !== "conformance-mismatch",
        message: mode === "conformance-mismatch"
          ? "generated provider ignored a require miss"
          : undefined
      },
      {
        id: "contract.target-port",
        passed: !wrongPort,
        message: wrongPort
          ? "candidate tried to satisfy hobo:cache/redis from cold-start material"
          : undefined
      }
    ]
  };
}

function traceReplayFor(mode) {
  const failed = mode === "trace-mismatch";
  return {
    passed: !failed,
    traces: [
      {
        id: "trace:database-happy-path",
        matched: !failed,
        expectedDigest: contentDigest({ trace: "expected-database-provider" }),
        actualDigest: failed
          ? contentDigest({ trace: "wrong-synthesis-guess" })
          : contentDigest({ trace: "expected-database-provider" }),
        reason: failed ? "candidate did not reproduce the recorded database trace" : undefined
      }
    ]
  };
}

function validationSandboxProfile() {
  return {
    schema: "hobo.sandbox.profile/v1",
    id: "hobo-348-cold-start-generation-profile",
    isolation: {
      tier: "microvm",
      engine: "firecracker"
    },
    network: {
      mode: "none",
      allow: []
    },
    filesystem: {
      scratch: "/sandbox/scratch",
      writable: ["/sandbox/scratch"],
      readonly: ["/workspace/input"]
    },
    capabilities: [
      {
        interface: "hobo:conformance/runner@0.1.0",
        stability: "preview",
        scope: {
          suiteId,
          targetPort
        },
        verbs: ["run"]
      }
    ],
    resources: {
      cpuMs: 30_000,
      memoryMiB: 512,
      wallClockMs: 60_000
    },
    assertions: [
      "no-egress",
      "capability-scoped",
      "scratch-only-write",
      "resource-budgeted"
    ]
  };
}

function certificationInput({
  request,
  fillCandidate,
  candidateRef,
  validationReport,
  conformanceReport,
  seed
}) {
  const gateDecision = {
    effect: "certify",
    reason: "cold-start database provider met conformance, replay, coverage, and provenance gates",
    policyRef: "policy:hobo-348-cold-start-reference-certify",
    policyInputHash: contentDigest({
      request,
      candidateRef,
      validationReportRef: validationReport.ref,
      conformanceReport,
      generationConfig
    })
  };

  return {
    requestId: request.requestId,
    candidate: {
      artifactKind: "provider-plugin",
      name: "@acme/provider-postgres",
      version: "0.1.0",
      artifactRef: {
        mediaType: "application/vnd.hobo.provider.layer.v1+json",
        uri: candidateRef.uri,
        digest: candidateRef.digest
      },
      claimedPorts: [targetPort]
    },
    validationReport,
    conformanceReport,
    evalReports: [
      {
        kind: "eval-report",
        name: "cold-start-provider-reference",
        digest: contentDigest({
          requestId: request.requestId,
          oracle: "conformance+trace-replay+coverage",
          materialProfile: fillCandidate.materialEvidence
        })
      }
    ],
    model,
    prompt: {
      id: "generate-provider-database-v1",
      frozenPromptDigest: fillCandidate.provenance.frozenPromptDigest
    },
    seed,
    gateDecision,
    certifiedAt: fixedTs
  };
}

function certificationValidationReport({ request, validationReport }) {
  const { ref: actualValidationReportRef, ...actualPayload } = validationReport;
  const payload = jsonClone({
    ...actualPayload,
    actualValidationReportRef,
    coveredPorts: [
      {
        witPort: validationReport.targetWitPort,
        suiteId: validationReport.conformance.suiteId,
        passed: validationReport.passed
      }
    ]
  });

  return {
    ...payload,
    ref: {
      uri: `draft://hobo-348-generation-reference/${request.requestId}/validation-report`,
      digest: contentDigest(payload)
    }
  };
}

function certificationConformanceReport({ request, suiteRun }) {
  return {
    schema: "hobo.conformance.report/v1",
    suiteId,
    targetPort,
    runId: request.requestId,
    passed: suiteRun.status === "pass",
    assertions: suiteRun.checks.map((check) => check.checkId).sort()
  };
}

function repairedCandidateRef({ request, seed, previousCandidateRef, failingAssertions, iteration }) {
  const digest = contentDigest({
    requestId: request.requestId,
    previousCandidateRef,
    failingAssertions,
    seed,
    iteration,
    targetPort,
    suiteId
  });
  return {
    uri: `draft://hobo-348-generation-reference/candidate-${iteration}@${digest}`,
    digest
  };
}

function digestRef(name, value) {
  const digest = contentDigest({ name, value });
  return {
    uri: `draft://hobo-348-generation-reference/${name}@${digest}`,
    digest
  };
}

function stageResults({ certified }) {
  return [
    { stage: "request", status: "accepted" },
    { stage: "scaffold", status: "candidate-generated" },
    { stage: "fill", status: "candidate-generated" },
    { stage: "repair", status: "converged-or-escalated" },
    { stage: "certify", status: certified ? "certified" : "not-certified" }
  ];
}

function needsHumanResult({ request, scaffold, materialProfile }) {
  const registry = createInMemoryCertificationRegistry();
  return {
    outcome: "needs-human",
    materialProfile,
    request,
    scaffold,
    fill: null,
    repair: {
      outcome: "needs-human",
      events: [scaffold.event],
      finalEvent: scaffold.event,
      repairAttempts: 0
    },
    validations: [],
    finalValidation: null,
    finalCandidateRef: null,
    coverage: {
      reference: { ok: false, reasons: ["scaffold did not produce a candidate"] },
      production: { ok: false, reasons: ["scaffold did not produce a candidate"] }
    },
    certification: null,
    registry,
    stageResults: stageResults({ certified: false })
  };
}

function assertPinnedInputs({ seed }) {
  if (!model.digest || /(^|[/:])latest($|[/:])/.test(model.id)) {
    throw new Error("generation.model_not_pinned");
  }
  if (generationConfig.temperature !== 0 || generationConfig.topP !== 1) {
    throw new Error("generation.sampling_not_deterministic");
  }
  if (!isJsonString(seed) || seed.length === 0) {
    throw new Error("generation.seed_not_pinned");
  }
}

function assertSigningKey(signingKey) {
  if (!signingKey?.keyId || !signingKey?.publicKeyPem || !signingKey?.privateKeyPem) {
    throw new Error("signingKey with keyId/publicKeyPem/privateKeyPem is required");
  }
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}
