import {
  rebuildGenerationRun,
  validateGenerationEvent,
  validateGenRequest
} from "../../generation-pipeline-io-contract/src/contract.js";
import { isJsonString, isJsonObject } from "./json.js";


const digestPattern = /^sha256:[a-f0-9]{64}$/;
const defaultActor = {
  kind: "agent",
  id: "agent:generation-repair-loop"
};

export class RepairLoopContractError extends Error {
  constructor(code, path = "$") {
    super(`${code} at ${path}`);
    this.code = code;
    this.path = path;
  }
}

export async function runBoundedRepairLoop(input) {
  assertObject(input, "repair.input", "$");

  const request = validateGenRequest(input.request);
  const initialCandidateRef = validateDigestRef(
    input.initialCandidateRef,
    "repair.initial_candidate",
    "$.initialCandidateRef"
  );
  const maxRepairAttempts = validateBudget(input.maxRepairAttempts);
  const validateCandidate = assertFunction(
    input.validateCandidate,
    "repair.validate_candidate",
    "$.validateCandidate"
  );
  const regenerateCandidate = assertFunction(
    input.regenerateCandidate,
    "repair.regenerate_candidate",
    "$.regenerateCandidate"
  );

  let candidateRef = initialCandidateRef;
  let repairAttempts = 0;
  let seq = input.seqStart ?? 1;
  if (!Number.isInteger(seq) || seq <= 0) {
    throw new RepairLoopContractError("repair.seq_start", "$.seqStart");
  }

  const context = {
    request,
    actor: input.actor ?? defaultActor,
    tenant: input.tenant ?? "tenant:demo",
    streamId: input.streamId ?? `generation:${request.requestId}`,
    ts: input.ts ?? new Date(0).toISOString()
  };
  const events = [];

  while (true) {
    const validation = normalizeValidationResult(
      await validateCandidate({
        request,
        candidateRef,
        iteration: repairAttempts
      }),
      candidateRef
    );

    if (validation.passed === true) {
      const finalEvent = buildEvent(context, seq++, "gen.Validated", {
        requestId: request.requestId,
        candidateRef: validation.candidateRef,
        validationReportRef: validation.validationReportRef,
        passed: true
      });
      events.push(finalEvent);

      return {
        outcome: "converged",
        events,
        finalEvent,
        repairAttempts
      };
    }

    const failingAssertions = validateFailingAssertions(validation.failingAssertions);
    events.push(
      buildEvent(context, seq++, "gen.ValidationFailed", {
        requestId: request.requestId,
        candidateRef: validation.candidateRef,
        validationReportRef: validation.validationReportRef,
        failingAssertions
      })
    );

    if (repairAttempts >= maxRepairAttempts) {
      const finalEvent = buildEvent(context, seq++, "gen.NeedsHuman", {
        requestId: request.requestId,
        reason: "repair-budget-exhausted",
        budgetExhausted: true,
        failingAssertions
      });
      events.push(finalEvent);

      return {
        outcome: "needs-human",
        events,
        finalEvent,
        repairAttempts
      };
    }

    repairAttempts += 1;
    const repair = await regenerateCandidate({
      request,
      previousCandidateRef: validation.candidateRef,
      failingAssertions,
      iteration: repairAttempts
    });
    candidateRef = validateDigestRef(repair?.candidateRef, "repair.candidate", "$.candidateRef");

    events.push(
      buildEvent(context, seq++, "gen.Repaired", {
        requestId: request.requestId,
        candidateRef,
        iteration: repairAttempts,
        failingAssertions
      })
    );
  }
}

export function replayBoundedRepairRun(events) {
  return rebuildGenerationRun(events);
}

function buildEvent(context, seq, type, data) {
  return validateGenerationEvent({
    id: `gen-repair-${context.request.requestId}-${seq}`,
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

function normalizeValidationResult(result, currentCandidateRef) {
  assertObject(result, "repair.validation", "$.validation");
  const candidateRef = validateDigestRef(
    result.candidateRef ?? currentCandidateRef,
    "repair.validation_candidate",
    "$.validation.candidateRef"
  );
  const validationReportRef = validateDigestRef(
    result.validationReportRef,
    "repair.validation_report",
    "$.validation.validationReportRef"
  );

  if (result.passed === true) {
    return {
      passed: true,
      candidateRef,
      validationReportRef
    };
  }

  if (result.passed === false) {
    return {
      passed: false,
      candidateRef,
      validationReportRef,
      failingAssertions: result.failingAssertions
    };
  }

  throw new RepairLoopContractError("repair.validation_passed", "$.validation.passed");
}

function validateBudget(maxRepairAttempts) {
  if (!Number.isInteger(maxRepairAttempts) || maxRepairAttempts < 1) {
    throw new RepairLoopContractError("repair.budget", "$.maxRepairAttempts");
  }

  return maxRepairAttempts;
}

function validateDigestRef(ref, code, path) {
  assertObject(ref, code, path);
  assertNonEmptyString(ref.uri, code, `${path}.uri`);
  if (!digestPattern.test(ref.digest ?? "")) {
    throw new RepairLoopContractError(`${code}_digest`, `${path}.digest`);
  }

  return ref;
}

function validateFailingAssertions(assertions) {
  if (
    !Array.isArray(assertions) ||
    assertions.length === 0 ||
    !assertions.every((assertion) => isJsonString(assertion) && assertion.length > 0)
  ) {
    throw new RepairLoopContractError("repair.failing_assertions", "$.failingAssertions");
  }

  return [...assertions];
}

function assertFunction(value, code, path) {
  if (!(value instanceof Function)) {
    throw new RepairLoopContractError(code, path);
  }

  return value;
}

function assertObject(value, code, path) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new RepairLoopContractError(code, path);
  }
}

function assertNonEmptyString(value, code, path) {
  if (!isJsonString(value) || value.length === 0) {
    throw new RepairLoopContractError(code, path);
  }
}
