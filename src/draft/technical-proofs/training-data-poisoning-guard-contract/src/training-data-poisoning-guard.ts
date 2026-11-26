import { isJsonString, isJsonObject } from "./json.js";
export const TRAINING_DATA_POISONING_GUARD_CONTRACT = "hobo.training-data-poisoning-guard/v1";

export function createPoisoningGuard(options = {}) {
  const config = {
    maxRewardInflation: options.maxRewardInflation ?? 0.35,
    maxCumulativeDrift: options.maxCumulativeDrift ?? 0.3,
    minIndependentSources: options.minIndependentSources ?? 3,
    minShadowSamples: options.minShadowSamples ?? 0,
    promotionRewardFloor: options.promotionRewardFloor ?? 0.75,
  };

  let seq = 0;

  function evaluateCandidate(input) {
    const candidateId = requireString(input?.candidateId, "candidateId");
    const trajectories = normalizeTrajectories(input?.trajectories);
    const labelsByTrajectory = groupLabels(input?.labels ?? []);
    const quarantines = [];

    const quarantine = (trajectoryId, reason, evidence = {}) => {
      if (quarantines.some((entry) => entry.trajectoryId === trajectoryId && entry.reason === reason)) {
        return;
      }
      const trajectory = trajectories.get(trajectoryId);
      quarantines.push({
        trajectoryId,
        reason,
        sourceFingerprint: trajectory?.sourceFingerprint ?? null,
        evidence,
      });
    };

    for (const [trajectoryId, labels] of labelsByTrajectory) {
      if (hasLabelFlip(labels)) {
        quarantine(trajectoryId, "label-flip", { labels: labels.map(labelEvidence) });
        continue;
      }

      const trajectory = trajectories.get(trajectoryId);
      const averageReward = average(labels.map((label) => label.reward));
      if (trajectory && averageReward - trajectory.reward > config.maxRewardInflation) {
        quarantine(trajectoryId, "reward-inflation", {
          observedReward: trajectory.reward,
          labeledReward: round(averageReward),
        });
      }
    }

    for (const [sourceFingerprint, sourceTrajectories] of groupTrajectoriesBySource(trajectories.values())) {
      const rewardRange = rewardRangeFor(sourceTrajectories);
      if (sourceTrajectories.length > 2 && rewardRange > config.maxCumulativeDrift) {
        for (const trajectory of sourceTrajectories) {
          quarantine(trajectory.id, "gradual-drift", {
            sourceFingerprint,
            rewardRange: round(rewardRange),
          });
        }
      }
    }

    const quarantinedIds = new Set(quarantines.map((entry) => entry.trajectoryId));
    const trustedTrajectories = [...trajectories.values()].filter((trajectory) => !quarantinedIds.has(trajectory.id));
    const trustedSources = new Set(trustedTrajectories.map((trajectory) => trajectory.sourceFingerprint));
    const shadowSampleCount = requireNonNegativeInteger(input?.shadow?.sampleCount ?? 0, "shadow.sampleCount");
    const trustedReward = average(
      trustedTrajectories.map((trajectory) => average(labelsByTrajectory.get(trajectory.id)?.map((label) => label.reward) ?? [trajectory.reward])),
    );

    const events = quarantines.map((entry) =>
      makeEvent("training.TrajectoryQuarantined", candidateId, {
        trajectoryId: entry.trajectoryId,
        reason: entry.reason,
        sourceFingerprint: entry.sourceFingerprint,
        evidence: entry.evidence,
      }),
    );

    events.push(
      makeEvent("training.CandidateInfluenceRecorded", candidateId, {
        trustedTrajectoryIds: trustedTrajectories.map((trajectory) => trajectory.id),
        quarantinedTrajectoryIds: [...quarantinedIds],
        trajectoryHashes: trustedTrajectories.map((trajectory) => trajectory.hash),
        independentSourceCount: trustedSources.size,
        shadowSampleCount,
      }),
    );

    const contractFailures = contractFailuresFor(input?.contract, trustedTrajectories);
    let decision;
    let reason;

    if (contractFailures.length > 0) {
      decision = "reject";
      reason = `contract backstop blocked promotion: ${contractFailures.join("; ")}`;
      events.push(makeEvent("training.CandidateRejected", candidateId, { reason, contractFailures }));
    } else if (trustedSources.size < config.minIndependentSources) {
      decision = "hold";
      reason = `independent sample floor not met: ${trustedSources.size}/${config.minIndependentSources}`;
      events.push(makeEvent("training.CandidateHeld", candidateId, { reason }));
    } else if (shadowSampleCount < config.minShadowSamples) {
      decision = "hold";
      reason = `shadow evidence floor not met: ${shadowSampleCount}/${config.minShadowSamples}`;
      events.push(makeEvent("training.CandidateHeld", candidateId, { reason }));
    } else if (trustedReward < config.promotionRewardFloor) {
      decision = "hold";
      reason = `trusted reward below promotion floor: ${round(trustedReward)}/${config.promotionRewardFloor}`;
      events.push(makeEvent("training.CandidateHeld", candidateId, { reason }));
    } else {
      decision = "promote";
      reason = "trusted trajectory set passed poisoning guard";
      events.push(
        makeEvent("training.CandidatePromoted", candidateId, {
          reason,
          trustedReward: round(trustedReward),
        }),
      );
    }

    return {
      decision,
      reason,
      quarantines: structuredClone(quarantines),
      trustedTrajectoryIds: trustedTrajectories.map((trajectory) => trajectory.id),
      independentSourceCount: trustedSources.size,
      shadowSampleCount,
      events,
    };
  }

  function makeEvent(type, candidateId, data) {
    const event = {
      schema: TRAINING_DATA_POISONING_GUARD_CONTRACT,
      id: `training-poison-${seq}`,
      type,
      streamId: `training:${candidateId}`,
      seq,
      time: new Date(Date.UTC(2026, 5, 27, 22, 0, seq)).toISOString(),
      data: {
        candidateId,
        ...structuredClone(data),
      },
    };
    seq += 1;
    return event;
  }

  return {
    evaluateCandidate,
  };
}

export function reconstructCandidateInfluence(events, candidateId) {
  requireString(candidateId, "candidateId");
  const ordered = orderEvents(events);
  const influence = ordered.find(
    (event) =>
      event.type === "training.CandidateInfluenceRecorded" && event.data?.candidateId === candidateId,
  );
  if (!influence) {
    throw new Error(`candidate influence not found: ${candidateId}`);
  }
  return {
    trustedTrajectoryIds: [...influence.data.trustedTrajectoryIds],
    quarantinedTrajectoryIds: [...influence.data.quarantinedTrajectoryIds],
    trajectoryHashes: [...influence.data.trajectoryHashes],
    independentSourceCount: influence.data.independentSourceCount,
    shadowSampleCount: influence.data.shadowSampleCount,
  };
}

function normalizeTrajectories(trajectories) {
  if (!Array.isArray(trajectories) || trajectories.length === 0) {
    throw new TypeError("trajectories must be a non-empty array");
  }
  const normalized = new Map();
  for (const trajectory of trajectories) {
    const id = requireString(trajectory?.id, "trajectory.id");
    if (normalized.has(id)) {
      throw new TypeError(`duplicate trajectory id: ${id}`);
    }
    const sourceFingerprint = requireString(trajectory?.sourceFingerprint, "trajectory.sourceFingerprint");
    const reward = requireReward(trajectory?.reward, "trajectory.reward");
    const hash = requireString(trajectory?.hash, "trajectory.hash");
    normalized.set(id, {
      id,
      hash,
      sourceFingerprint,
      reward,
      contractPassed: trajectory.contractPassed !== false,
      output: structuredClone(trajectory.output ),
    });
  }
  return normalized;
}

function groupLabels(labels) {
  if (!Array.isArray(labels)) {
    throw new TypeError("labels must be an array");
  }
  const grouped = new Map();
  for (const label of labels) {
    const trajectoryId = requireString(label?.trajectoryId, "label.trajectoryId");
    const entry = {
      trajectoryId,
      labelerId: requireString(label?.labelerId, "label.labelerId"),
      reward: requireReward(label?.reward, "label.reward"),
      scores: structuredClone(label?.scores ),
    };
    grouped.set(trajectoryId, [...(grouped.get(trajectoryId) ?? []), entry]);
  }
  return grouped;
}

function hasLabelFlip(labels) {
  if (labels.length < 2) {
    return false;
  }
  const fingerprints = new Set(labels.map((label) => JSON.stringify(sortKeys({
    reward: label.reward,
    scores: label.scores,
  }))));
  return fingerprints.size > 1;
}

function groupTrajectoriesBySource(trajectories) {
  const grouped = new Map();
  for (const trajectory of trajectories) {
    grouped.set(trajectory.sourceFingerprint, [...(grouped.get(trajectory.sourceFingerprint) ?? []), trajectory]);
  }
  return grouped;
}

function rewardRangeFor(trajectories) {
  const rewards = trajectories.map((trajectory) => trajectory.reward);
  return Math.max(...rewards) - Math.min(...rewards);
}

function contractFailuresFor(contract, trustedTrajectories) {
  const failures = [];
  if (contract?.passed === false) {
    failures.push(...(Array.isArray(contract.failures) && contract.failures.length > 0 ? contract.failures : ["contract failed"]));
  }
  for (const trajectory of trustedTrajectories) {
    if (!trajectory.contractPassed) {
      failures.push(`trajectory ${trajectory.id} violates contract`);
    }
  }
  return failures;
}

function labelEvidence(label) {
  return {
    labelerId: label.labelerId,
    reward: label.reward,
    scores: structuredClone(label.scores),
  };
}

function orderEvents(events) {
  if (!Array.isArray(events)) {
    throw new TypeError("events must be an array");
  }
  return [...events].sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
}

function requireString(value, name) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireReward(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${name} must be between 0 and 1`);
  }
  return value;
}

function requireNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function average(values) {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value) {
  return Number(value.toFixed(6));
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
