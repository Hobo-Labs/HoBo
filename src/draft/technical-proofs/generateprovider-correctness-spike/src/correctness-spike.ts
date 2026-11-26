import { isJsonString } from "./json.js";
import {
  authoritativeContractFromRequest,
  validateGenRequest
} from "../../generation-pipeline-io-contract/src/contract.js";
import { runBoundedRepairLoop } from "../../generation-bounded-repair-loop-contract/src/bounded-repair-loop.js";
import {
  createGenerationCertifyStage,
  createInMemoryCertificationRegistry
} from "../../generation-certify-stage-contract/src/certify-stage.js";
import { runValidationStage } from "../../generation-validation-stage-contract/src/validation-stage.js";
import {
  createReferenceLocalProvider,
  runProviderCapabilitySuites
} from "../../provider-capability-conformance-suites/src/provider-capability-conformance.js";
import { contentDigest } from "../../slsa-provenance-certification-contract/src/provenance.js";

export const DEFAULT_REPAIR_BUDGET = 2;

const targetPort = "hobo:database/postgres@0.1.0";
const suiteId = "conformance.provider.database@0.1.0";
const fixedTs = "2026-06-26T14:00:00.000Z";
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
    version: "pinned",
    generationConfig
  })
});
const prompt = Object.freeze({
  id: "generate-provider-database-v1",
  frozenPromptDigest: contentDigest({
    template: "generate-provider",
    targetPort,
    safety: "contract-first"
  })
});

const requiredDatabaseCoverage = Object.freeze([
  "database.local.provision-connects",
  "database.local.honors-require-prefer",
  "database.local.refresh-reports-drift",
  "database.local.destroy-cleans-state"
]);
const requiredProductionDatabaseCoverage = Object.freeze([
  ...requiredDatabaseCoverage,
  "database.camp.real-provider-drift",
  "database.camp.iam-mtls-quota-evidence"
]);

export function buildGenerateProviderRequest(overrides = {}) {
  return validateGenRequest({
    schema: "hobo.gen.request/v1",
    requestId: "gen-provider-database-reference",
    artifactKind: "provider",
    target: {
      witPort: targetPort
    },
    capabilityManifestRef: digestRef("capability-manifest", {
      provider: "@acme/provider-postgres",
      port: targetPort
    }),
    authoritativeRefs: [
      {
        kind: "wit",
        ref: "wit://hobo/database@0.1.0"
      },
      {
        kind: "conformance-suite",
        suiteId,
        ref: "oci://registry.example/hobo/conformance/database@sha256:1111"
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
        kind: "recorded-traces",
        ref: "oci://registry.example/hobo/traces/database-reference@sha256:2222",
        trusted: false,
        sanitized: true
      }
    ],
    ...overrides
  });
}

export async function runReferenceDatabaseProviderGeneration({
  signingKey,
  requestOverrides,
  validationScript = ["pass"],
  coverageTags = ["local"],
  seed = "seed-hobo-211",
  repairBudget = DEFAULT_REPAIR_BUDGET
} = {}) {
  assertSigningKey(signingKey);
  assertPinnedGenerationInputs({ model, prompt, generationConfig, seed });

  const request = buildGenerateProviderRequest(requestOverrides);
  const contract = authoritativeContractFromRequest(request);
  const provider = createReferenceLocalProvider({
    claimedCapabilities: ["database"],
    campBehavior: "pass"
  });
  const suiteRun = runProviderCapabilitySuites(provider, {
    capabilities: ["database"],
    tags: coverageTags
  });
  const coverage = assessProviderSuiteCoverage({
    capability: "database",
    suiteRun,
    profile: "reference"
  });
  const productionCoverage = assessProviderSuiteCoverage({
    capability: "database",
    suiteRun,
    profile: "production"
  });
  const validations = [];
  const remainingScript = [...validationScript];
  const initialCandidateRef = candidateRefFor({ request, seed, iteration: 0 });

  const repair = await runBoundedRepairLoop({
    request,
    initialCandidateRef,
    maxRepairAttempts: repairBudget,
    validateCandidate: async ({ candidateRef, iteration }) => {
      const mode = remainingScript.shift() ?? "pass";
      const validation = await validateCandidate({
        request,
        candidateRef,
        contract,
        mode,
        seq: 3 + iteration * 2
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
    regenerateCandidate: async ({ iteration }) => ({
      candidateRef: candidateRefFor({ request, seed, iteration })
    }),
    seqStart: 1,
    ts: fixedTs
  });

  const finalValidation = validations.at(-1) ?? null;
  const finalCandidateRef = repair.finalEvent.data.candidateRef ?? initialCandidateRef;

  if (repair.outcome !== "converged" || !coverage.ok) {
    return {
      request,
      repair,
      validations,
      finalValidation,
      finalCandidateRef,
      coverage,
      productionCoverage,
      certification: null,
      registry: createInMemoryCertificationRegistry()
    };
  }

  const registry = createInMemoryCertificationRegistry({
    trustedKeys: { [signingKey.keyId]: signingKey.publicKeyPem }
  });
  const certification = createGenerationCertifyStage({ registry, signingKey }).certify(
    certificationInput({
      request,
      candidateRef: finalCandidateRef,
      validationReport: certificationValidationReport({
        request,
        validationReport: finalValidation.report
      }),
      conformanceReport: certificationConformanceReport({
        request,
        suiteRun,
        passed: true
      }),
      seed
    })
  );

  return {
    request,
    repair,
    validations,
    finalValidation,
    finalCandidateRef,
    coverage,
    productionCoverage,
    certification,
    registry
  };
}

export async function runGenerateProviderNonConvergenceProof(options = {}) {
  return runReferenceDatabaseProviderGeneration({
    ...options,
    validationScript: ["trace-mismatch", "conformance-mismatch", "trace-mismatch"]
  });
}

export function assessProviderSuiteCoverage({
  capability,
  suiteRun,
  profile = "production",
  campEvidence = "none"
}) {
  const required = coverageRequirements({ capability, profile });
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
  if (
    profile === "production" &&
    required.some((checkId) => checkId.includes(".camp.")) &&
    campEvidence !== "real"
  ) {
    reasons.push("production coverage requires real Camp evidence, not fixture evidence");
  }

  return Object.freeze({
    ok: reasons.length === 0 && suiteRun?.status === "pass",
    capability,
    profile,
    reasons: Object.freeze(reasons),
    requiredChecks: required,
    observedChecks: Object.freeze([...observed.keys()].sort())
  });
}

export function assertPinnedGenerationInputs({
  model: candidateModel,
  prompt: candidatePrompt,
  generationConfig: candidateConfig,
  seed
}) {
  if (!candidateModel?.digest || /(^|[/:])latest($|[/:])/.test(candidateModel.id ?? "")) {
    throw new Error("generation.model_not_pinned");
  }
  if (!candidatePrompt?.frozenPromptDigest) {
    throw new Error("generation.prompt_not_frozen");
  }
  if (candidateConfig?.temperature !== 0 || candidateConfig?.topP !== 1) {
    throw new Error("generation.sampling_not_deterministic");
  }
  if (!isJsonString(seed) || seed.length === 0) {
    throw new Error("generation.seed_not_pinned");
  }
  return true;
}

function coverageRequirements({ capability, profile }) {
  if (capability !== "database") {
    return [];
  }
  return profile === "reference" ? requiredDatabaseCoverage : requiredProductionDatabaseCoverage;
}

async function validateCandidate({ request, candidateRef, contract, mode, seq }) {
  return runValidationStage({
    request,
    candidate: {
      requestId: request.requestId,
      artifactKind: request.artifactKind,
      targetWitPort: contract.target.witPort,
      conformanceSuiteId: contract.conformanceSuiteId,
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
  const failed = mode === "conformance-mismatch";
  return {
    suiteId,
    targetPort,
    passed: !failed,
    assertions: [
      { id: "contract.connects", passed: true },
      { id: "contract.destroy.clean", passed: true },
      {
        id: "contract.require-miss",
        passed: !failed,
        message: failed ? "generated provider ignored a require miss" : undefined
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
        expectedDigest: contentDigest({ trace: "expected-database" }),
        actualDigest: failed
          ? contentDigest({ trace: "wrong-cache-behavior" })
          : contentDigest({ trace: "expected-database" }),
        reason: failed ? "candidate did not reproduce the recorded database trace" : undefined
      }
    ]
  };
}

function validationSandboxProfile() {
  return {
    schema: "hobo.sandbox.profile/v1",
    id: "generateprovider-correctness-profile",
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

function certificationInput({ request, candidateRef, validationReport, conformanceReport, seed }) {
  const gateDecision = {
    effect: "certify",
    reason: "reference provider generation met conformance, replay, coverage, and provenance gates",
    policyRef: "policy:generateprovider-reference-certify",
    policyInputHash: contentDigest({
      request,
      candidateRef,
      validationReportRef: validationReport.actualValidationReportRef,
      certificationValidationReportRef: validationReport.ref,
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
        name: "provider-correctness-reference",
        digest: contentDigest({
          requestId: request.requestId,
          oracle: "conformance+trace-replay+coverage"
        })
      }
    ],
    model,
    prompt,
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
      uri: `draft://generateprovider-correctness/${request.requestId}/validation-report`,
      digest: contentDigest(payload)
    }
  };
}

function certificationConformanceReport({ request, suiteRun, passed }) {
  return {
    schema: "hobo.conformance.report/v1",
    suiteId,
    targetPort,
    runId: request.requestId,
    passed,
    assertions: suiteRun.checks.map((check) => check.checkId).sort()
  };
}

function candidateRefFor({ request, seed, iteration }) {
  const digest = contentDigest({
    requestId: request.requestId,
    target: request.target,
    capabilityManifestDigest: request.capabilityManifestRef.digest,
    authoritativeRefs: request.authoritativeRefs,
    materialRefs: request.materialRefs,
    model,
    prompt,
    generationConfig,
    seed,
    iteration,
    template: "provider-database-reference-v1"
  });

  return {
    uri: `draft://generateprovider-correctness/candidate-${iteration}@${digest}`,
    digest
  };
}

function digestRef(name, value) {
  const digest = contentDigest({ name, value });
  return {
    uri: `draft://generateprovider-correctness/${name}@${digest}`,
    digest
  };
}

function assertSigningKey(signingKey) {
  if (!signingKey?.keyId || !signingKey?.publicKeyPem || !signingKey?.privateKeyPem) {
    throw new Error("signingKey with keyId/publicKeyPem/privateKeyPem is required");
  }
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}
