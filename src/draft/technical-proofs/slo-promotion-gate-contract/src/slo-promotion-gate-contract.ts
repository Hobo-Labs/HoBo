import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const SLO_PROMOTION_GATE_CONTRACT_VERSION = "hobo.slo-promotion-gate/v1";
export const PROMOTION_GATE_DECIDED_EVENT = "delivery.PromotionGateDecided";

export function resolvePromotionPolicy(policy, reliabilitySnapshot) {
  assertObject(policy, "policy");
  assertObject(reliabilitySnapshot, "reliabilitySnapshot");

  if (!isJsonString(policy.id) || policy.id.length === 0) {
    throw new Error("promotion policy requires an id");
  }
  if (!Array.isArray(policy.gates) || policy.gates.length === 0) {
    throw new Error("promotion policy requires at least one SLO gate");
  }
  if (!Number.isInteger(reliabilitySnapshot.seq) || reliabilitySnapshot.seq < 0) {
    throw new Error("reliability snapshot requires a non-negative integer seq");
  }

  const slos = new Map((reliabilitySnapshot.slos ?? []).map((slo) => [slo.id, slo]));
  const gates = policy.gates.map((gate) => {
    assertObject(gate, "gate");
    const slo = slos.get(gate.sloId);
    if (!slo) {
      throw new Error(`unknown SLO id ${gate.sloId}`);
    }

    return {
      sloId: gate.sloId,
      analysisWindow: gate.analysisWindow,
      thresholds: clone(gate.thresholds),
      snapshot: {
        burnRate: slo.burnRate,
        remainingBudgetRatio: slo.remainingBudgetRatio,
        status: slo.status
      }
    };
  });

  const resolved = {
    version: SLO_PROMOTION_GATE_CONTRACT_VERSION,
    seq: reliabilitySnapshot.seq,
    generatedAt: reliabilitySnapshot.generatedAt,
    policyId: policy.id,
    gates
  };

  if (policy.goldenSuite !== undefined) {
    resolved.goldenSuite = clone(policy.goldenSuite);
  }

  return resolved;
}

export function evaluatePromotionGate(resolvedInput) {
  assertObject(resolvedInput, "resolvedInput");

  if ((resolvedInput.goldenSuite?.failures ?? []).length > 0) {
    return verdict("rollback", "golden-suite-failure");
  }

  for (const gate of resolvedInput.gates ?? []) {
    if (gate.snapshot?.status !== "available") {
      return verdict("hold", `slo-snapshot-${gate.snapshot?.status ?? "unavailable"}`);
    }
  }

  for (const gate of resolvedInput.gates ?? []) {
    const { burnRate, remainingBudgetRatio } = gate.snapshot;
    const thresholds = gate.thresholds ?? {};

    if (burnRate >= thresholds.rollbackBurnRate) {
      return verdict("rollback", "slo-burn-rate-rollback-threshold", gate.sloId);
    }
    if (remainingBudgetRatio <= thresholds.minRemainingBudgetRatio) {
      return verdict("rollback", "slo-budget-exhausted", gate.sloId);
    }
    if (burnRate >= thresholds.holdBurnRate) {
      return verdict("hold", "slo-burn-rate-hold-threshold", gate.sloId);
    }
  }

  return verdict("promote", "within-slo-budget");
}

export function createGateDecision(resolvedInput, { decisionId, rolloutId }) {
  const result = evaluatePromotionGate(resolvedInput);

  return {
    id: decisionId,
    type: PROMOTION_GATE_DECIDED_EVENT,
    payload: {
      rolloutId,
      verdict: result.verdict,
      reason: result.reason,
      reasonSloId: result.sloId,
      input: clone(resolvedInput),
      inputHash: stableDigest(resolvedInput)
    }
  };
}

export function stableDigest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function verdict(verdictValue, reason, sloId) {
  return {
    verdict: verdictValue,
    reason,
    sloId
  };
}

function assertObject(value, name) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}
