import { createHash } from "node:crypto";

import {
  contentDigest
} from "../../slsa-provenance-certification-contract/src/provenance.js";
import {
  createGenerationCertifyStage,
  createInMemoryCertificationRegistry
} from "../../generation-certify-stage-contract/src/certify-stage.js";
import {
  fillGenerationCandidate
} from "../../generation-llm-fill-contract/src/fill.js";
import {
  rebuildGenerationRun,
  validateGenerationEvent,
  validateGenRequest
} from "../../generation-pipeline-io-contract/src/contract.js";
import {
  runBoundedRepairLoop
} from "../../generation-bounded-repair-loop-contract/src/bounded-repair-loop.js";
import {
  scaffoldGenerationRequest
} from "../../generation-scaffold-stage-contract/src/scaffold.js";
import {
  runValidationStage
} from "../../generation-validation-stage-contract/src/validation-stage.js";
import { isJsonString, isJsonObject } from "./json.js";


const providerArtifactMediaType = "application/vnd.hobo.provider.layer.v1+json";
const defaultModel = Object.freeze({
  provider: "fixture",
  id: "deterministic-provider-loop-poc",
  digest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
});

export class ProviderGenerationLoopError extends Error {
  constructor(code, path = "$") {
    super(`${code} at ${path}`);
    this.name = "ProviderGenerationLoopError";
    this.code = code;
    this.path = path;
  }
}

export async function generateProvider(input) {
  assertObject(input, "provider_loop.input", "$");
  const runConformance = assertFunction(
    input.runConformance,
    "provider_loop.run_conformance",
    "$.runConformance"
  );
  const replayTraces = assertFunction(
    input.replayTraces,
    "provider_loop.replay_traces",
    "$.replayTraces"
  );
  const signingKey = expectSigningKey(input.signingKey);
  const seed = nonEmptyString(input.seed ?? "seed-provider-loop-poc", "$.seed");
  const model = input.model ?? defaultModel;
  const ts = input.ts ?? "2026-06-26T00:00:00.000Z";
  const requestNormalization = normalizeProviderRequest(input.request, input.materials ?? []);
  const request = validateGenRequest(requestNormalization.request);
  const requestedEvent = generationEvent(request, 1, ts, "gen.Requested", request);

  const scaffold = scaffoldGenerationRequest(request, { seq: 2, ts });
  if (scaffold.status === "needs-human") {
    return needsHumanResult({
      request,
      material: requestNormalization.material,
      events: [requestedEvent, scaffold.event],
      reason: scaffold.event.data.reason
    });
  }

  const filled = fillGenerationCandidate(request, scaffold.candidate, {
    seq: 3,
    ts,
    seed,
    model
  });
  const initialProvider = providerCandidateFromFill(filled.candidate, input);
  const candidates = new Map([[initialProvider.ref.digest, initialProvider]]);
  const validationReports = new Map();
  let lastCandidateRef = initialProvider.ref;

  const repair = await runBoundedRepairLoop({
    request,
    initialCandidateRef: initialProvider.ref,
    maxRepairAttempts: input.maxRepairAttempts ?? 2,
    seqStart: 4,
    ts,
    validateCandidate: async ({ candidateRef, iteration }) => {
      lastCandidateRef = candidateRef;
      const candidate = candidateForRef(candidates, candidateRef);
      const validation = await runValidationStage({
        request,
        candidate,
        sandboxProfile: input.sandboxProfile,
        seq: 100 + iteration,
        ts,
        runConformance: async (runnerInput) =>
          enforceCoverage(
            await runConformance({ ...runnerInput, provider: candidate, iteration }),
            requiredAssertionsFor(request, input.requiredConformanceAssertions)
          ),
        replayTraces: async (runnerInput) =>
          replayTraces({ ...runnerInput, provider: candidate, iteration })
      });

      validationReports.set(candidateRef.digest, validation.report);
      if (validation.outcome === "validated") {
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
    regenerateCandidate: async ({ previousCandidateRef, failingAssertions, iteration }) => {
      const repaired = repairProviderCandidate(
        candidateForRef(candidates, previousCandidateRef),
        failingAssertions,
        iteration
      );
      candidates.set(repaired.ref.digest, repaired);
      lastCandidateRef = repaired.ref;
      return { candidateRef: repaired.ref };
    }
  });

  const events = [requestedEvent, scaffold.event, filled.event, ...repair.events];
  if (repair.outcome !== "converged") {
    return needsHumanResult({
      request,
      material: requestNormalization.material,
      provider: candidateForRef(candidates, lastCandidateRef),
      validationReport: validationReports.get(lastCandidateRef.digest),
      events,
      reason: repair.finalEvent.data.reason
    });
  }

  const provider = candidateForRef(candidates, repair.finalEvent.data.candidateRef);
  const validationReport = validationReports.get(provider.ref.digest);
  const certificationInput = buildCertificationInput({
    request,
    provider,
    validationReport,
    material: requestNormalization.material,
    model,
    seed,
    promptId: input.promptId ?? "generate-provider-v1",
    certifiedAt: input.certifiedAt ?? ts
  });
  const registry =
    input.registry ??
    createInMemoryCertificationRegistry({
      trustedKeys: { [signingKey.keyId]: signingKey.publicKeyPem }
    });
  const certifyStage = createGenerationCertifyStage({ registry, signingKey });
  const certification = certifyStage.certify(certificationInput);
  if (certification.ok !== true) {
    throw new ProviderGenerationLoopError(
      `provider_loop.certification_rejected:${certification.reasons.join("|")}`,
      "$.certification"
    );
  }
  const certifiedEvent = buildCertifiedEvent({
    request,
    provider,
    validationReport: certificationInput.validationReport,
    certification,
    seq: events.length + 1,
    ts
  });
  const allEvents = [...events, certifiedEvent];

  return Object.freeze({
    status: "certified",
    request,
    material: requestNormalization.material,
    scaffold: scaffold.candidate,
    filled: filled.candidate,
    provider,
    validationReport: certificationInput.validationReport,
    conformanceReport: certificationInput.conformanceReport,
    certification,
    registryEvents: registry.events instanceof Function ? registry.events() : [],
    events: allEvents,
    replay: rebuildGenerationRun(allEvents)
  });
}

function normalizeProviderRequest(request, materials) {
  const parsed = assertObject(request, "provider_loop.request", "$.request");
  const allMaterialRefs = [...(parsed.materialRefs ?? []), ...materials];
  const material = sanitizeMaterials(allMaterialRefs);
  const normalized = {
    ...parsed,
    materialRefs: material.refs
  };

  if (!normalized.capabilityManifestRef) {
    const manifestDigest = contentDigest({
      requestId: parsed.requestId,
      target: parsed.target,
      authoritativeRefs: parsed.authoritativeRefs,
      materialRefs: material.refs
    });
    normalized.capabilityManifestRef = {
      uri: `draft://generation-provider-loop/${parsed.requestId}/cold-start-manifest@${manifestDigest}`,
      digest: manifestDigest
    };
    material.coldStartManifest = Object.freeze({
      generated: true,
      reason: "capability-manifest-absent",
      ref: normalized.capabilityManifestRef
    });
  }

  return {
    request: normalized,
    material: Object.freeze(material)
  };
}

function sanitizeMaterials(materialRefs) {
  if (!Array.isArray(materialRefs)) {
    throw new ProviderGenerationLoopError("provider_loop.material_refs", "$.materials");
  }

  const findings = [];
  const refs = materialRefs.map((material, index) => {
    const parsed = assertObject(material, "provider_loop.material_ref", `$.materials[${index}]`);
    const rawRef = nonEmptyString(
      parsed.ref ?? parsed.content ?? parsed.uri,
      `$.materials[${index}].ref`
    );
    const codes = promptInjectionFindings(rawRef);
    const requiresSanitizedRef =
      isJsonString(parsed.content) ||
      codes.length > 0 ||
      parsed.sanitized !== true ||
      parsed.trusted !== false;
    if (codes.length > 0 || parsed.sanitized !== true || parsed.trusted !== false) {
      findings.push({
        index,
        kind: parsed.kind ?? "material",
        codes
      });
    }

    return {
      kind: parsed.kind ?? "material",
      ref: requiresSanitizedRef ? `draft://sanitized-material/${sha256Digest(rawRef)}` : rawRef,
      trusted: false,
      sanitized: true
    };
  });

  return {
    refs,
    scrubReport: Object.freeze({
      schema: "hobo.gen.material-scrub-report/v1",
      sanitized: true,
      materialCount: refs.length,
      findings
    }),
    coldStartManifest: null
  };
}

function promptInjectionFindings(value) {
  const checks = [
    ["prompt-injection.ignore-contract", /ignore\s+(the\s+)?(contract|instructions|system)/i],
    ["prompt-injection.override-contract", /override\s+(the\s+)?(contract|port|capabilit)/i],
    ["prompt-injection.claim-port", /claim\s+hobo:[^\s;]+/i],
    ["prompt-injection.backdoor", /(admin\s+backdoor|exfiltrat|secret)/i]
  ];
  return checks.filter(([, pattern]) => pattern.test(value)).map(([code]) => code);
}

function providerCandidateFromFill(fillCandidate, input) {
  const providerName = input.providerName ?? generatedProviderName(fillCandidate.targetWitPort);
  const version = input.version ?? "0.1.0";
  const candidate = {
    requestId: fillCandidate.requestId,
    artifactKind: "provider",
    name: providerName,
    version,
    targetWitPort: fillCandidate.targetWitPort,
    conformanceSuiteId: fillCandidate.authoritativeInputs.conformanceSuiteId,
    claimedCapabilities: [...fillCandidate.claimedCapabilities],
    claimedPorts: [fillCandidate.targetWitPort],
    filledBytes: fillCandidate.filledBytes,
    provenance: fillCandidate.provenance,
    repairHistory: [],
    ref: fillCandidate.ref
  };

  return Object.freeze(candidate);
}

function repairProviderCandidate(candidate, failingAssertions, iteration) {
  const next = {
    ...candidate,
    repairHistory: [
      ...candidate.repairHistory,
      {
        iteration,
        failingAssertions: [...failingAssertions]
      }
    ],
    filledBytes: [
      candidate.filledBytes.trimEnd(),
      `// repair iteration ${iteration}: ${failingAssertions.join(", ")}`
    ].join("\n")
  };
  const digest = contentDigest(withoutRef(next));
  return Object.freeze({
    ...next,
    ref: {
      uri: `draft://generation-provider-loop/${candidate.requestId}/candidate-${iteration}@${digest}`,
      digest
    }
  });
}

function buildCertificationInput({
  request,
  provider,
  validationReport,
  material,
  model,
  seed,
  promptId,
  certifiedAt
}) {
  const report = certificationValidationReport(validationReport);
  const conformanceReport = {
    schema: "hobo.conformance.report/v1",
    suiteId: report.conformance.suiteId,
    targetPort: report.conformance.targetPort,
    runId: report.requestId,
    passed: report.conformance.passed,
    assertions: report.conformance.assertions.map((assertion) => assertion.id)
  };

  return {
    requestId: request.requestId,
    candidate: {
      artifactKind: "provider-plugin",
      name: provider.name,
      version: provider.version,
      artifactRef: {
        mediaType: providerArtifactMediaType,
        uri: `oci://registry.example/hobo/${provider.name}@${provider.ref.digest}`,
        digest: provider.ref.digest
      },
      claimedPorts: [...provider.claimedPorts]
    },
    validationReport: report,
    conformanceReport,
    evalReports: [
      {
        kind: "material-scrub-report",
        name: "sanitized-untrusted-material",
        digest: contentDigest(material.scrubReport)
      },
      {
        kind: "sandbox-validation-report",
        name: "no-egress-conformance-run",
        digest: contentDigest(report.sandbox)
      },
      {
        kind: "trace-replay-report",
        name: "recorded-trace-replay",
        digest: contentDigest(report.traceReplay)
      }
    ],
    model,
    prompt: {
      id: promptId,
      frozenPromptDigest: provider.provenance.frozenPromptDigest
    },
    seed,
    gateDecision: {
      effect: "certify",
      reason: "provider-generation-loop-green",
      policyRef: "policy:allow-provider-generation-certify",
      policyInputHash: contentDigest({
        requestId: request.requestId,
        candidateRef: provider.ref,
        validationReportRef: report.ref,
        scrubReport: material.scrubReport
      })
    },
    certifiedAt
  };
}

function certificationValidationReport(report) {
  const payload = {
    schema: report.schema,
    requestId: report.requestId,
    candidateRef: cleanJson(report.candidateRef),
    targetWitPort: report.targetWitPort,
    coveredPorts: [
      {
        witPort: report.targetWitPort,
        suiteId: report.conformance.suiteId,
        passed: report.passed
      }
    ],
    sandbox: cleanJson(report.sandbox),
    conformance: cleanJson(report.conformance),
    traceReplay: cleanJson(report.traceReplay),
    passed: report.passed
  };
  const digest = contentDigest(payload);
  return Object.freeze({
    ...payload,
    ref: {
      uri: report.ref.uri,
      digest
    }
  });
}

function buildCertifiedEvent({ request, provider, validationReport, certification, seq, ts }) {
  return generationEvent(request, seq, ts, "gen.Certified", {
    schema: "hobo.gen.result/v1",
    requestId: request.requestId,
    candidateRef: provider.ref,
    validationReportRef: validationReport.ref,
    provenanceRef: {
      uri: `draft://generation-provider-loop/${request.requestId}/provenance@${contentDigest(
        certification.record.payload.provenance
      )}`,
      digest: contentDigest(certification.record.payload.provenance)
    },
    gateDecision: {
      effect: "certify",
      policyRef: certification.record.payload.gateDecision.policyRef
    }
  });
}

function needsHumanResult({ request, material, provider, validationReport, events, reason }) {
  return Object.freeze({
    status: "needs-human",
    request,
    material,
    provider,
    validationReport,
    reason,
    events,
    replay: rebuildGenerationRun(events)
  });
}

function enforceCoverage(result, requiredAssertions) {
  const parsed = assertObject(result, "provider_loop.conformance_result", "$.conformance");
  const assertions = Array.isArray(parsed.assertions) ? [...parsed.assertions] : [];
  const seen = new Set(assertions.map((assertion) => assertion?.id));
  for (const required of requiredAssertions) {
    if (!seen.has(required)) {
      assertions.push({
        id: `suite.coverage:${required}`,
        passed: false,
        message: `required check missing: ${required}`
      });
    }
  }

  return {
    ...parsed,
    assertions,
    passed: parsed.passed === true && assertions.every((assertion) => assertion.passed === true)
  };
}

function requiredAssertionsFor(request, configured) {
  if (configured) {
    if (!Array.isArray(configured) || configured.length === 0) {
      throw new ProviderGenerationLoopError(
        "provider_loop.required_assertions",
        "$.requiredConformanceAssertions"
      );
    }
    return configured;
  }

  if (request.target.witPort.includes("database/") || request.target.witPort.includes("postgres")) {
    return ["contract.connects", "contract.destroy.clean"];
  }

  return ["contract.connects"];
}

function candidateForRef(candidates, ref) {
  const candidate = candidates.get(ref.digest);
  if (!candidate) {
    throw new ProviderGenerationLoopError("provider_loop.candidate_ref_unknown", "$.candidateRef");
  }
  return candidate;
}

function generatedProviderName(witPort) {
  const family = witPort
    .toLowerCase()
    .split("@", 1)[0]
    .replace(/^.*:/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `@generated/provider-${family}`;
}

function generationEvent(request, seq, ts, type, data) {
  return validateGenerationEvent({
    id: `gen-provider-loop-${request.requestId}-${seq}`,
    type,
    v: 1,
    streamId: `generation:${request.requestId}`,
    seq,
    ts,
    actor: {
      kind: "agent",
      id: "agent:generate-provider"
    },
    tenant: "tenant:demo",
    correlationId: request.requestId,
    data
  });
}

function expectSigningKey(signingKey) {
  const key = assertObject(signingKey, "provider_loop.signing_key", "$.signingKey");
  nonEmptyString(key.keyId, "$.signingKey.keyId");
  nonEmptyString(key.publicKeyPem, "$.signingKey.publicKeyPem");
  nonEmptyString(key.privateKeyPem, "$.signingKey.privateKeyPem");
  return key;
}

function assertFunction(value, code, path) {
  if (!(value instanceof Function)) {
    throw new ProviderGenerationLoopError(code, path);
  }
  return value;
}

function assertObject(value, code, path) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new ProviderGenerationLoopError(code, path);
  }
  return value;
}

function nonEmptyString(value, path) {
  if (!isJsonString(value) || value.length === 0) {
    throw new ProviderGenerationLoopError("provider_loop.expected_string", path);
  }
  return value;
}

function withoutRef(candidate) {
  const { ref, ...payload } = candidate;
  void ref;
  return payload;
}

function sha256Digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cleanJson(value) {
  return JSON.parse(JSON.stringify(value));
}
