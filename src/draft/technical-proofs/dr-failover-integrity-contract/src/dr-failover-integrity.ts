import {
  buildDisasterRecoveryPostmortem,
  orchestrateDisasterRecovery,
} from "../../disaster-recovery-failover-contract/src/disaster-recovery-failover.js";
import { isJsonString, isJsonObject } from "./json.js";


const EVENT_TYPES = {
  ownerSelected: "failoverIntegrity.OwnerSelected",
  ownerRejected: "failoverIntegrity.OwnerCandidateRejected",
  staleOwnerRejected: "failoverIntegrity.StaleOwnerRejected",
  rpoDeclared: "failoverIntegrity.RpoDeclared",
  replayCertified: "failoverIntegrity.ReplayCertified",
};

export async function certifyFailoverIntegrity(input = {}) {
  const dr = await orchestrateDisasterRecovery(input);
  const state = {
    actorKey: dr.fencing.actorKey,
    ownerNode: dr.fencing.newOwnerNode,
    fenceToken: dr.fencing.newFenceToken,
    headSeq: dr.restore.source.replicatedSeq,
  };
  const ownerDecision = decideOwner({
    candidates: input.doubleFailoverCandidates,
    state,
  });
  const staleOwner = normalizeStaleOwner(dr.fencing.stalePrimaryAppend);
  const rpo = {
    ...dr.restore.rpo,
    honestStatement: buildDisasterRecoveryPostmortem(dr.events),
  };
  const integrityEvents = buildIntegrityEvents({
    state,
    ownerDecision,
    staleOwner,
    rpo,
  });

  return deepFreeze({
    status: "integrity-certified",
    state,
    integrity: {
      ownerDecision,
      staleOwner,
      rpo,
    },
    disasterRecovery: dr,
    events: {
      ...dr.events,
      integrity: integrityEvents,
    },
  });
}

export function replayFailoverIntegrity(events = []) {
  if (!Array.isArray(events)) {
    throw new Error("events must be an array");
  }

  const selected = events.filter((event) => event.type === EVENT_TYPES.ownerSelected);
  const replayCertified = events.find((event) => event.type === EVENT_TYPES.replayCertified);
  const rejectedOwners = events
    .filter((event) => event.type === EVENT_TYPES.ownerRejected)
    .map((event) => event.payload.ownerNode);
  const owners = [...new Set(selected.map((event) => event.payload.ownerNode))];

  return deepFreeze({
    status: owners.length === 1 ? "consistent" : "conflicted",
    owners,
    rejectedOwners,
    stateHead: replayCertified?.payload.stateHead ?? null,
  });
}

export async function resumeInterruptedFailover(input = {}) {
  const checkpoint = validateCheckpoint(input.checkpoint);
  const proof = await certifyFailoverIntegrity(input);

  if (checkpoint.actorKey !== proof.state.actorKey) {
    throw new Error("checkpoint actorKey does not match restored actor");
  }
  if (checkpoint.fenceToken !== proof.state.fenceToken) {
    throw new Error("checkpoint fenceToken does not match restored fence");
  }

  const orderedSteps = ["fence-original-owner", "restore-from-log", "verify-rpo-rto", "complete-runbook"];
  const completed = new Set(checkpoint.completedSteps);
  const doubleAppliedSteps = checkpoint.completedSteps.filter(
    (step, index) => checkpoint.completedSteps.indexOf(step) !== index,
  );

  return deepFreeze({
    ...proof,
    status: "restored",
    recovery: {
      checkpointId: checkpoint.id,
      idempotencyKey: checkpoint.idempotencyKey,
      replayedCompletedSteps: orderedSteps.filter((step) => completed.has(step)),
      remainingSteps: orderedSteps.filter((step) => !completed.has(step)),
      doubleAppliedSteps,
    },
  });
}

function decideOwner({ candidates, state }) {
  if (!candidates) {
    return {
      selected: {
        ownerNode: state.ownerNode,
        fenceToken: state.fenceToken,
        quorumVotes: null,
        sourceSeq: state.headSeq,
      },
      rejected: [],
    };
  }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("doubleFailoverCandidates must be a non-empty array");
  }

  const normalized = candidates.map(validateCandidate).sort(compareCandidate);
  const selected = normalized[0];
  if (selected.ownerNode !== state.ownerNode || selected.fenceToken !== state.fenceToken) {
    throw new Error("selected failover candidate must match restored owner and fence");
  }

  return {
    selected,
    rejected: normalized.slice(1).map((candidate) => ({
      ...candidate,
      reason: candidate.fenceToken < selected.fenceToken ? "stale-fence-rejected" : "lost-quorum",
    })),
  };
}

function compareCandidate(left, right) {
  return right.quorumVotes - left.quorumVotes
    || right.fenceToken - left.fenceToken
    || right.sourceSeq - left.sourceSeq
    || left.ownerNode.localeCompare(right.ownerNode);
}

function validateCandidate(candidate) {
  if (!candidate || !isJsonObject(candidate) || Array.isArray(candidate)) {
    throw new Error("failover candidate must be an object");
  }

  return {
    ownerNode: requiredString(candidate.ownerNode, "candidate.ownerNode"),
    fenceToken: nonNegativeInteger(candidate.fenceToken, "candidate.fenceToken"),
    quorumVotes: nonNegativeInteger(candidate.quorumVotes, "candidate.quorumVotes"),
    sourceSeq: nonNegativeInteger(candidate.sourceSeq, "candidate.sourceSeq"),
  };
}

function normalizeStaleOwner(stalePrimaryAppend) {
  const accepted = stalePrimaryAppend?.accepted === true;
  return {
    ...stalePrimaryAppend,
    accepted,
    seqCommitted: accepted,
    reason: stalePrimaryAppend?.reason ?? "no-contending-append",
  };
}

function buildIntegrityEvents({ state, ownerDecision, staleOwner, rpo }) {
  const selectedEvent = {
    id: `failover-integrity-owner-${slug(ownerDecision.selected.ownerNode)}`,
    type: EVENT_TYPES.ownerSelected,
    payload: {
      actorKey: state.actorKey,
      ownerNode: ownerDecision.selected.ownerNode,
      fenceToken: ownerDecision.selected.fenceToken,
      quorumVotes: ownerDecision.selected.quorumVotes,
      sourceSeq: ownerDecision.selected.sourceSeq,
    },
  };
  const rejectedEvents = ownerDecision.rejected.map((candidate) => ({
    id: `failover-integrity-rejected-${slug(candidate.ownerNode)}`,
    type: EVENT_TYPES.ownerRejected,
    payload: candidate,
  }));
  const staleEvent = {
    id: `failover-integrity-stale-owner-${slug(state.actorKey)}`,
    type: EVENT_TYPES.staleOwnerRejected,
    payload: staleOwner,
  };
  const rpoEvent = {
    id: `failover-integrity-rpo-${slug(rpo.label)}`,
    type: EVENT_TYPES.rpoDeclared,
    payload: rpo,
  };
  const replayEvent = {
    id: `failover-integrity-replay-${slug(state.actorKey)}`,
    type: EVENT_TYPES.replayCertified,
    payload: {
      stateHead: {
        actorKey: state.actorKey,
        ownerNode: state.ownerNode,
        fenceToken: state.fenceToken,
        seq: state.headSeq,
      },
    },
  };

  return [selectedEvent, ...rejectedEvents, staleEvent, rpoEvent, replayEvent];
}

function validateCheckpoint(checkpoint) {
  if (!checkpoint || !isJsonObject(checkpoint) || Array.isArray(checkpoint)) {
    throw new Error("checkpoint is required");
  }
  if (!Array.isArray(checkpoint.completedSteps)) {
    throw new Error("checkpoint.completedSteps must be an array");
  }

  return {
    id: requiredString(checkpoint.id, "checkpoint.id"),
    completedSteps: checkpoint.completedSteps.map((step) => requiredString(step, "checkpoint.completedSteps[]")),
    actorKey: requiredString(checkpoint.actorKey, "checkpoint.actorKey"),
    fenceToken: nonNegativeInteger(checkpoint.fenceToken, "checkpoint.fenceToken"),
    idempotencyKey: requiredString(checkpoint.idempotencyKey, "checkpoint.idempotencyKey"),
  };
}

function requiredString(value, fieldName) {
  if (!isJsonString(value) || value.trim().length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return value.trim();
}

function nonNegativeInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
  return value;
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}
