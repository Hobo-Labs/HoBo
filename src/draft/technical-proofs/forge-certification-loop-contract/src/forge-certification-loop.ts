import { createHash } from "node:crypto";

import {
  rebuildGenerationRun,
  validateGenerationEvent,
  validateGenRequest
} from "../../generation-pipeline-io-contract/src/contract.js";
import {
  declareConformanceRun,
  profileDigest,
  validateSandboxEvent,
  validateSandboxProfile
} from "../../no-egress-generation-sandbox-contract/src/contract.js";
import { isJsonString, isJsonBoolean, isJsonObject } from "./json.js";


const digestPattern = /^sha256:[a-f0-9]{64}$/;
const defaultActor = {
  kind: "agent",
  id: "agent:forge-certification-loop"
};

export class ForgeCertificationLoopError extends Error {
  constructor(code, path = "$") {
    super(`${code} at ${path}`);
    this.code = code;
    this.path = path;
  }
}

export async function runForgeCertificationLoop(input) {
  assertObject(input, "forge.input", "$");

  const request = validateGenRequest(input.request);
  const sandboxProfile = validateSandboxProfile(input.sandboxProfile);
  const profileDigestValue = profileDigest(sandboxProfile);
  const suites = validateConformanceSuites(input.conformanceSuites);
  const maxRepairAttempts = validateBudget(input.maxRepairAttempts);
  const validateInSandbox = assertFunction(
    input.validateInSandbox,
    "forge.validate_in_sandbox",
    "$.validateInSandbox"
  );
  const repairCandidate = assertFunction(
    input.repairCandidate,
    "forge.repair_candidate",
    "$.repairCandidate"
  );

  let candidate = validateCandidate(input.initialCandidate, request.requestId);
  let repairAttempts = 0;
  let seq = input.seqStart ?? 1;
  if (!Number.isInteger(seq) || seq <= 0) {
    throw new ForgeCertificationLoopError("forge.seq_start", "$.seqStart");
  }

  const context = {
    request,
    sandboxProfile,
    profileDigest: profileDigestValue,
    suites,
    actor: input.actor ?? defaultActor,
    tenant: input.tenant ?? "tenant:demo",
    streamId: input.streamId ?? `forge:${request.requestId}`,
    ts: input.ts ?? new Date(0).toISOString()
  };
  const events = [];
  const auditEvents = [];

  while (true) {
    const sandboxDeclaration = declareConformanceRun(sandboxProfile, {
      runId: `${request.requestId}-attempt-${repairAttempts}`,
      suiteId: suites.map((suite) => suite.suiteId).join("+"),
      artifactKind: request.artifactKind,
      targetPort: request.target.witPort,
      validator: input.validator ?? "@hobo/conformance"
    });

    const validation = normalizeValidationResult(
      await validateInSandbox({
        request,
        candidate,
        sandboxProfile,
        sandboxDeclaration,
        conformanceSuites: suites,
        repairAttempts
      }),
      candidate
    );

    if (validation.passed === true) {
      const gate = runCertificationGate({
        candidate: validation.candidate,
        sandboxRerun: validation.sandboxRerun,
        sandboxEvents: validation.sandboxEvents ?? []
      });

      if (!gate.ok) {
        auditEvents.push(...gate.auditEvents);
        const refusalEvent = buildEvent(context, seq++, "gen.SafetyRejected", {
          requestId: request.requestId,
          candidateRef: validation.candidate.ref,
          validationReportRef: validation.validationReportRef,
          safetyReportRef: gate.safetyReportRef,
          failingAssertions: gate.failingAssertions
        });
        events.push(refusalEvent);

        return {
          outcome: "refused",
          refusalReason: gate.reason,
          events,
          auditEvents,
          finalEvent: refusalEvent,
          repairAttempts
        };
      }

      const validatedEvent = buildEvent(context, seq++, "gen.Validated", {
        requestId: request.requestId,
        candidateRef: validation.candidate.ref,
        validationReportRef: validation.validationReportRef,
        passed: true
      });
      events.push(validatedEvent);

      const certifiedEvent = buildEvent(context, seq++, "gen.Certified", {
        schema: "hobo.gen.result/v1",
        requestId: request.requestId,
        candidateRef: validation.candidate.ref,
        validationReportRef: validation.validationReportRef,
        provenanceRef: digestRef(
          `draft://forge-certification/${request.requestId}/provenance@${profileDigestValue}`,
          profileDigestValue
        ),
        gateDecision: {
          effect: "certify",
          policyRef: `policy://forge/certification/${request.requestId}`
        }
      });
      events.push(certifiedEvent);

      return {
        outcome: "certified",
        events,
        auditEvents,
        finalEvent: certifiedEvent,
        repairAttempts
      };
    }

    if (validation.repairable === false) {
      auditEvents.push(...(validation.auditEvents ?? []));
      const refusalEvent = buildEvent(context, seq++, "gen.SafetyRejected", {
        requestId: request.requestId,
        candidateRef: validation.candidate.ref,
        validationReportRef: validation.validationReportRef,
        safetyReportRef: validation.safetyReportRef,
        failingAssertions: validation.failingAssertions
      });
      events.push(refusalEvent);

      return {
        outcome: "refused",
        refusalReason: validation.refusalReason,
        events,
        auditEvents,
        finalEvent: refusalEvent,
        repairAttempts
      };
    }

    const failingAssertions = validateFailingAssertions(validation.failingAssertions);
    events.push(
      buildEvent(context, seq++, "gen.ValidationFailed", {
        requestId: request.requestId,
        candidateRef: validation.candidate.ref,
        validationReportRef: validation.validationReportRef,
        failingAssertions
      })
    );

    if (repairAttempts >= maxRepairAttempts) {
      const needsHumanEvent = buildEvent(context, seq++, "gen.NeedsHuman", {
        requestId: request.requestId,
        reason: "repair-budget-exhausted",
        budgetExhausted: true,
        failingAssertions
      });
      events.push(needsHumanEvent);

      return {
        outcome: "needs-human",
        events,
        auditEvents,
        finalEvent: needsHumanEvent,
        repairAttempts
      };
    }

    repairAttempts += 1;
    const repaired = await repairCandidate({
      request,
      candidate: validation.candidate,
      failingAssertions,
      iteration: repairAttempts
    });
    candidate = validateCandidate(repaired.candidate, request.requestId);

    events.push(
      buildEvent(context, seq++, "gen.Repaired", {
        requestId: request.requestId,
        candidateRef: candidate.ref,
        iteration: repairAttempts,
        failingAssertions
      })
    );
  }
}

export function replayForgeCertificationRun(events) {
  return rebuildGenerationRun(events);
}

export function runCertificationGate({ candidate, sandboxRerun, sandboxEvents }) {
  const parsedCandidate = validateCandidate(candidate, candidate.requestId ?? "forge");
  const parsedRerun = validateSandboxRerun(sandboxRerun);
  const parsedEvents = (sandboxEvents ?? []).map((event) => validateSandboxEvent(event));
  const auditEvents = [];
  const failingAssertions = [];

  const attachment = parsedCandidate.attachedConformanceReport;
  if (
    attachment?.passed === true &&
    attachment.digest !== parsedRerun.digest
  ) {
    failingAssertions.push("conformance.report_forged");
    auditEvents.push({
      type: "conformance.ReportRejected",
      reason: "conformance.report_mismatch",
      attachmentDigest: attachment.digest,
      sandboxDigest: parsedRerun.digest
    });
  }

  if (attachment?.passed === true && parsedRerun.passed === false) {
    if (!failingAssertions.includes("conformance.report_forged")) {
      failingAssertions.push("conformance.report_forged");
    }
    auditEvents.push({
      type: "conformance.ReportRejected",
      reason: "conformance.in_boundary_rerun_failed",
      attachmentDigest: attachment.digest,
      sandboxDigest: parsedRerun.digest
    });
  }

  for (const event of parsedEvents) {
    if (event.type === "sandbox.EscapeAttemptBlocked") {
      failingAssertions.push("sandbox.undeclared_egress");
      auditEvents.push({
        type: "sandbox.EgressDenied",
        attempt: event.attempt,
        profileDigest: event.profileDigest
      });
    }
  }

  if (failingAssertions.length === 0) {
    return { ok: true, auditEvents: [] };
  }

  const safetyReportRef = digestRef(
    `draft://forge-certification/${parsedCandidate.requestId}/safety@${digestPayload({
      candidateRef: parsedCandidate.ref,
      failingAssertions
    })}`,
    digestPayload({ candidateRef: parsedCandidate.ref, failingAssertions })
  );

  return {
    ok: false,
    reason: failingAssertions[0],
    failingAssertions: [...new Set(failingAssertions)],
    safetyReportRef,
    auditEvents
  };
}

function normalizeValidationResult(result, currentCandidate) {
  assertObject(result, "forge.validation", "$.validation");
  const candidate = validateCandidate(result.candidate ?? currentCandidate, currentCandidate.requestId);
  const validationReportRef = validateDigestRef(
    result.validationReportRef,
    "forge.validation_report",
    "$.validation.validationReportRef"
  );

  if (result.passed === true) {
    return {
      passed: true,
      candidate,
      validationReportRef,
      sandboxRerun: result.sandboxRerun,
      sandboxEvents: result.sandboxEvents ?? []
    };
  }

  if (result.repairable === false) {
    return {
      passed: false,
      repairable: false,
      candidate,
      validationReportRef,
      refusalReason: result.refusalReason ?? "forge.validation_refused",
      failingAssertions: validateFailingAssertions(result.failingAssertions),
      safetyReportRef: validateDigestRef(
        result.safetyReportRef,
        "forge.safety_report",
        "$.validation.safetyReportRef"
      ),
      auditEvents: result.auditEvents ?? []
    };
  }

  if (result.passed === false) {
    return {
      passed: false,
      repairable: true,
      candidate,
      validationReportRef,
      failingAssertions: result.failingAssertions
    };
  }

  throw new ForgeCertificationLoopError("forge.validation_passed", "$.validation.passed");
}

function validateCandidate(candidate, requestId) {
  assertObject(candidate, "forge.candidate", "$.candidate");
  assertNonEmptyString(candidate.requestId ?? requestId, "forge.candidate_request", "$.candidate.requestId");
  const ref = validateDigestRef(candidate.ref, "forge.candidate_ref", "$.candidate.ref");
  assertNonEmptyString(candidate.targetWitPort, "forge.target_wit_port", "$.candidate.targetWitPort");

  if (candidate.attachedConformanceReport) {
    validateAttachedReport(candidate.attachedConformanceReport);
  }

  return {
    requestId: candidate.requestId ?? requestId,
    targetWitPort: candidate.targetWitPort,
    ref,
    attachedConformanceReport: candidate.attachedConformanceReport ?? null
  };
}

function validateAttachedReport(report) {
  assertObject(report, "forge.attached_report", "$.attachedConformanceReport");
  assertNonEmptyString(report.suiteId, "forge.attached_suite", "$.attachedConformanceReport.suiteId");
  if (!isJsonBoolean(report.passed)) {
    throw new ForgeCertificationLoopError("forge.attached_passed", "$.attachedConformanceReport.passed");
  }
  if (!digestPattern.test(report.digest ?? "")) {
    throw new ForgeCertificationLoopError("forge.attached_digest", "$.attachedConformanceReport.digest");
  }
}

function validateSandboxRerun(rerun) {
  assertObject(rerun, "forge.sandbox_rerun", "$.sandboxRerun");
  assertNonEmptyString(rerun.suiteId, "forge.rerun_suite", "$.sandboxRerun.suiteId");
  if (!isJsonBoolean(rerun.passed)) {
    throw new ForgeCertificationLoopError("forge.rerun_passed", "$.sandboxRerun.passed");
  }
  if (!digestPattern.test(rerun.digest ?? "")) {
    throw new ForgeCertificationLoopError("forge.rerun_digest", "$.sandboxRerun.digest");
  }
  return rerun;
}

function validateConformanceSuites(suites) {
  if (!Array.isArray(suites) || suites.length === 0) {
    throw new ForgeCertificationLoopError("forge.conformance_suites", "$.conformanceSuites");
  }

  return suites.map((suite, index) => {
    const path = `$.conformanceSuites[${index}]`;
    assertObject(suite, "forge.suite", path);
    assertNonEmptyString(suite.suiteId, "forge.suite_id", `${path}.suiteId`);
    assertNonEmptyString(suite.witInterface, "forge.wit_interface", `${path}.witInterface`);
    return {
      suiteId: suite.suiteId,
      witInterface: suite.witInterface
    };
  });
}

function validateBudget(maxRepairAttempts) {
  if (!Number.isInteger(maxRepairAttempts) || maxRepairAttempts < 1) {
    throw new ForgeCertificationLoopError("forge.budget", "$.maxRepairAttempts");
  }
  return maxRepairAttempts;
}

function buildEvent(context, seq, type, data) {
  return validateGenerationEvent({
    id: `forge-cert-${context.request.requestId}-${seq}`,
    type,
    v: 1,
    streamId: context.streamId,
    seq,
    ts: context.ts,
    actor: context.actor,
    tenant: context.tenant,
    correlationId: context.request.requestId,
    data
  });
}

function validateDigestRef(ref, code, path) {
  assertObject(ref, code, path);
  assertNonEmptyString(ref.uri, code, `${path}.uri`);
  if (!digestPattern.test(ref.digest ?? "")) {
    throw new ForgeCertificationLoopError(`${code}_digest`, `${path}.digest`);
  }
  return ref;
}

function validateFailingAssertions(assertions) {
  if (
    !Array.isArray(assertions) ||
    assertions.length === 0 ||
    !assertions.every((assertion) => isJsonString(assertion) && assertion.length > 0)
  ) {
    throw new ForgeCertificationLoopError("forge.failing_assertions", "$.failingAssertions");
  }
  return [...assertions];
}

function digestRef(uri, digestValue) {
  return { uri, digest: digestValue };
}

function digestPayload(value) {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function stableStringify(value) {
  if (value === null || !isJsonObject(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function assertFunction(value, code, path) {
  if (!(value instanceof Function)) {
    throw new ForgeCertificationLoopError(code, path);
  }
  return value;
}

function assertObject(value, code, path) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new ForgeCertificationLoopError(code, path);
  }
}

function assertNonEmptyString(value, code, path) {
  if (!isJsonString(value) || value.length === 0) {
    throw new ForgeCertificationLoopError(code, path);
  }
}
