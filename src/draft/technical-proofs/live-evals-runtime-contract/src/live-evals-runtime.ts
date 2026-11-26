import {
  evaluatePromotionCandidate,
  makeEvalEvent,
  validatePromotionGate,
} from "../../eval-promotion-gate-contract/src/eval-promotion-gate.js";
import { isJsonString, isJsonNumber, isJsonObject } from "./json.js";


export const LIVE_EVALS_RUNTIME_CONTRACT = "hobo.live-evals-runtime/v1";

export function createLiveEvalRuntime({ gate }) {
  const parsedGate = validatePromotionGate(gate);
  if (!parsedGate.ok) {
    throw new Error(parsedGate.errors.join("\n"));
  }

  const stableGate = parsedGate.gate;
  const events = [];
  const rewards = new Map();
  const candidateStates = new Map();
  let seq = 0;

  function evaluateBatch(batch) {
    const normalized = normalizeBatch(batch);
    const poison = detectPoisonedLabelBatch(normalized.labelBatch);
    if (poison) {
      const event = appendEvent("eval.LabelBatchQuarantined", normalized, {
        labelBatchId: normalized.labelBatch.id,
        reason: poison,
      });
      return result({
        outcome: "label-batch-quarantined",
        events: [event],
        failures: [poison],
        rewardWrites: [],
        telemetry: null,
        gateMoved: false,
      });
    }

    const scores = averageScores(normalized.labelBatch.labels);
    const telemetry = summarizeTelemetry(normalized.labelBatch.labels);
    const evalRan = appendEvalRan(normalized, scores, telemetry);
    const rewardWrites = writeRewards(normalized, evalRan.id);
    const emitted = [evalRan, ...rewardWrites.map((write) => write.event)];

    if (normalized.arm === "challenger") {
      const floorFailures = floorFailuresFor(normalized);
      if (floorFailures.length > 0) {
        emitted.push(appendEvent("eval.GateHeld", normalized, { failures: floorFailures }));
        setCandidateState(normalized.candidateId, "shadow", "floors-held");
        return result({
          outcome: "gate-held",
          events: emitted,
          failures: floorFailures,
          rewardWrites,
          telemetry,
          gateMoved: false,
          candidateState: candidateStates.get(normalized.candidateId),
        });
      }
    }

    const decision = evaluatePromotionCandidate(stableGate, {
      candidateId: normalized.candidateId,
      championId: normalized.championId,
      conformance: normalized.conformance,
      policy: normalized.policy,
      samples: normalized.labelBatch.labels.length,
      scores,
    });

    if (normalized.arm === "champion") {
      if (decision.passFlags.eval) {
        setCandidateState(normalized.candidateId, "champion", "healthy");
        return result({
          outcome: "champion-healthy",
          events: emitted,
          failures: [],
          rewardWrites,
          telemetry,
          gateMoved: false,
          candidateState: candidateStates.get(normalized.candidateId),
        });
      }

      emitted.push(
        appendEvent("eval.DriftDetected", normalized, {
          failures: decision.failures,
          liveFix: {
            mode: "propose",
            applied: false,
          },
        }),
      );
      setCandidateState(normalized.candidateId, "champion", "drift-alerted");
      return result({
        outcome: "champion-drift",
        events: emitted,
        failures: decision.failures,
        rewardWrites,
        telemetry,
        gateMoved: false,
        candidateState: candidateStates.get(normalized.candidateId),
      });
    }

    if (decision.outcome === "promote") {
      emitted.push(appendGateDecision("eval.GatePassed", normalized, decision));
      setCandidateState(normalized.candidateId, "gate-passed", "awaiting-promotion-primitive");
      return result({
        outcome: "gate-passed",
        events: emitted,
        failures: [],
        rewardWrites,
        telemetry,
        gateMoved: true,
        candidateState: candidateStates.get(normalized.candidateId),
      });
    }

    emitted.push(appendGateDecision("eval.GateFailed", normalized, decision));
    setCandidateState(normalized.candidateId, "shadow", "eval-regressed");
    return result({
      outcome: "stay-shadow",
      events: emitted,
      failures: decision.failures,
      rewardWrites,
      telemetry,
      gateMoved: true,
      candidateState: candidateStates.get(normalized.candidateId),
    });
  }

  function appendEvalRan(batch, scores, telemetry) {
    const event = makeEvalEvent({
      id: `eval-${seq}`,
      type: "eval.Ran",
      semanticFunction: batch.semanticFunction,
      candidateId: batch.candidateId,
      seq,
      data: {
        labelBatchId: batch.labelBatch.id,
        samples: batch.labelBatch.labels.length,
        scores,
        telemetry,
      },
    });
    seq += 1;
    events.push(event);
    return event;
  }

  function appendGateDecision(type, batch, decision) {
    const event = makeEvalEvent({
      id: `eval-${seq}`,
      type,
      semanticFunction: batch.semanticFunction,
      candidateId: batch.candidateId,
      seq,
      data: decision,
    });
    seq += 1;
    events.push(event);
    return event;
  }

  function appendEvent(type, batch, data) {
    const event = {
      schema: LIVE_EVALS_RUNTIME_CONTRACT,
      id: `eval-${seq}`,
      type,
      streamId: `eval:${batch.semanticFunction}:${batch.candidateId}`,
      seq,
      time: new Date(Date.UTC(2026, 5, 26, 0, 0, seq)).toISOString(),
      data: {
        semanticFunction: batch.semanticFunction,
        candidateId: batch.candidateId,
        championId: batch.championId,
        arm: batch.arm,
        ...data,
      },
    };
    seq += 1;
    events.push(event);
    return event;
  }

  function writeRewards(batch, evalEventId) {
    return batch.labelBatch.labels.map((label) => {
      const write = {
        trajectoryId: label.trajectoryId,
        reward: label.reward,
        rubricRef: `promotionGate:${batch.semanticFunction}`,
        evalEventId,
      };
      rewards.set(label.trajectoryId, {
        reward: write.reward,
        rubricRef: write.rubricRef,
        evalEventId,
      });
      write.event = appendEvent("training.TrajectoryRewarded", batch, {
        trajectoryId: label.trajectoryId,
        reward: label.reward,
        rubricRef: write.rubricRef,
        evalEventId,
      });
      return write;
    });
  }

  function setCandidateState(candidateId, stage, reason) {
    candidateStates.set(candidateId, { candidateId, stage, reason });
  }

  function floorFailuresFor(batch) {
    const failures = [];
    const sampleCount = batch.labelBatch.labels.length;
    if (sampleCount < stableGate.minSamples) {
      failures.push(`samples below minSamples ${stableGate.minSamples}`);
    }

    const requiredShadow = parsePercent(stableGate.shadowTraffic);
    const actualShadow = parsePercent(batch.traffic.shadowTraffic ?? "0%");
    if (actualShadow < requiredShadow) {
      failures.push(`shadow traffic below floor ${formatPercent(requiredShadow)}`);
    }

    return failures;
  }

  return {
    evaluateBatch,
    events: () => structuredClone(events),
    rewardForTrajectory: (trajectoryId) => structuredClone(rewards.get(trajectoryId) ?? null),
  };
}

function normalizeBatch(batch) {
  if (!batch || !isJsonObject(batch) || Array.isArray(batch)) {
    throw new TypeError("batch must be an object");
  }
  if (!["champion", "challenger"].includes(batch.arm)) {
    throw new TypeError("arm must be champion or challenger");
  }
  for (const field of ["semanticFunction", "candidateId", "championId"]) {
    if (!isJsonString(batch[field]) || batch[field].length === 0) {
      throw new TypeError(`${field} must be a non-empty string`);
    }
  }
  if (!batch.labelBatch || !isJsonObject(batch.labelBatch)) {
    throw new TypeError("labelBatch must be an object");
  }
  if (!isJsonString(batch.labelBatch.id) || batch.labelBatch.id.length === 0) {
    throw new TypeError("labelBatch.id must be a non-empty string");
  }
  if (!Array.isArray(batch.labelBatch.labels) || batch.labelBatch.labels.length === 0) {
    throw new TypeError("labelBatch.labels must be a non-empty array");
  }

  return {
    ...batch,
    conformance: batch.conformance ?? { passed: false },
    policy: batch.policy ?? { effect: "deny" },
    traffic: batch.traffic ?? {},
  };
}

function detectPoisonedLabelBatch(labelBatch) {
  if (labelBatch.integrity?.verdict !== "trusted") {
    return "label batch integrity is not trusted";
  }

  const seen = new Map();
  for (const label of labelBatch.labels) {
    requireLabel(label);
    const fingerprint = JSON.stringify({ scores: sortKeys(label.scores), reward: label.reward });
    const prior = seen.get(label.trajectoryId);
    if (prior !== undefined && prior !== fingerprint) {
      return `conflicting labels for ${label.trajectoryId}`;
    }
    seen.set(label.trajectoryId, fingerprint);
  }
  return null;
}

function requireLabel(label) {
  if (!label || !isJsonObject(label) || Array.isArray(label)) {
    throw new TypeError("label must be an object");
  }
  if (!isJsonString(label.trajectoryId) || label.trajectoryId.length === 0) {
    throw new TypeError("label.trajectoryId must be a non-empty string");
  }
  if (!isJsonNumber(label.reward) || label.reward < 0 || label.reward > 1) {
    throw new TypeError("label.reward must be between 0 and 1");
  }
}

function averageScores(labels) {
  const names = Object.keys(labels[0].scores ?? {});
  return Object.fromEntries(
    names.map((name) => [name, round(labels.reduce((sum, label) => sum + Number(label.scores?.[name] ?? 0), 0) / labels.length)]),
  );
}

function summarizeTelemetry(labels) {
  const metric = (name) => labels.map((label) => Number(label.metrics?.[name] ?? 0));
  return {
    calibration: round(average(metric("calibration"))),
    costUsd: round(metric("costUsd").reduce((sum, value) => sum + value, 0), 5),
    latencyMs: round(average(metric("latencyMs"))),
    quality: round(average(metric("quality"))),
  };
}

function result(value) {
  return {
    candidateState: null,
    failures: [],
    gateMoved: false,
    ...value,
    rewardWrites: value.rewardWrites.map(({ event: _event, ...write }) => write),
  };
}

function parsePercent(value) {
  const match = /^([0-9]+(?:\.[0-9]+)?)%$/.exec(value);
  if (!match) {
    throw new TypeError(`percent must be a string like 10%: ${value}`);
  }
  return Number(match[1]) / 100;
}

function formatPercent(value) {
  return `${round(value * 100, 4)}%`;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value, digits = 6) {
  return Number(value.toFixed(digits));
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
