import { isJsonString, isJsonObject } from "./json.js";
const FIDELITY_RANK = Object.freeze({
  "camp-only": 0,
  mocked: 1,
  simulated: 2,
  real: 3,
});

export function auditFidelityCatalog(entries) {
  const labels = {};
  const failures = [];

  for (const entry of entries ?? []) {
    const capability = requireNonEmptyString(entry.capability, "capability");
    const declared = entry.declaredFidelity;
    if (!declared) {
      labels[capability] = "camp-only";
      failures.push({
        capability,
        code: "HOBO_DEV_FIDELITY_UNDECLARED",
        message: `${capability} has no fidelity label and defaults to camp-only, never real`,
      });
      continue;
    }

    const declaredFidelity = requireFidelity(declared, "declaredFidelity");
    const observedFidelity = requireFidelity(entry.observedFidelity ?? declaredFidelity, "observedFidelity");
    labels[capability] = declaredFidelity;

    if (FIDELITY_RANK[observedFidelity] < FIDELITY_RANK[declaredFidelity]) {
      failures.push({
        capability,
        code: "HOBO_DEV_FIDELITY_MISLABELED",
        message: `${capability} declares ${declaredFidelity} but only proves ${observedFidelity}`,
        evidence: clone(entry.evidence),
      });
    }
  }

  return deepFreeze({
    status: failures.length === 0 ? "pass" : "fail",
    labels,
    failures,
  });
}

export function evaluateProdReadyClaim({ capability, declaredFidelity, evidence } = {}) {
  const name = requireNonEmptyString(capability, "capability");
  const fidelity = requireFidelity(declaredFidelity ?? "camp-only", "declaredFidelity");

  if (fidelity === "mocked" || fidelity === "camp-only" || evidence?.camp === "unrun") {
    return deepFreeze({
      status: "blocked",
      code: "HOBO_DEV_PROD_READY_DEFER_TO_CAMP",
      message: `${name} cannot claim prod-ready from ${fidelity} local evidence; defer to Camp`,
      evidence: clone(evidence ?? {}),
    });
  }

  return deepFreeze({
    status: "pass",
    code: "HOBO_DEV_PROD_READY_ACCEPTED",
    message: `${name} has local and Camp evidence for prod-ready claim`,
    evidence: clone(evidence ?? {}),
  });
}

export function createForkLane({ id, service, into, baseline }) {
  const laneId = requireNonEmptyString(id, "id");
  const baselineState = cloneRecord(baseline ?? {});
  const laneState = cloneRecord(baseline ?? {});
  const writes = new Map();

  return Object.freeze({
    id: laneId,
    service: requireNonEmptyString(service, "service"),
    into: requireNonEmptyString(into, "into"),
    read(key) {
      return clone(laneState[requireNonEmptyString(key, "key")]);
    },
    write(key, value) {
      const stableKey = requireNonEmptyString(key, "key");
      laneState[stableKey] = clone(value);
      writes.set(stableKey, clone(value));
    },
    diff() {
      const diff = {};
      for (const key of [...writes.keys()].sort()) {
        diff[key] = {
          baseline: clone(baselineState[key]),
          lane: clone(laneState[key]),
        };
      }
      return deepFreeze({ id: laneId, service, into, writes: diff });
    },
  });
}

export function compareLocalAndCamp({
  capability,
  declaredFidelity,
  localResult,
  campResult,
  contractResult,
} = {}) {
  const name = requireNonEmptyString(capability, "capability");
  const fidelity = requireFidelity(declaredFidelity ?? "camp-only", "declaredFidelity");

  if (campResult?.incident || campResult?.observed === "unavailable") {
    return deepFreeze({
      status: "blocked",
      code: "HOBO_DEV_CAMP_UNCERTAIN",
      message: `${name} has uncertain Camp evidence; cannot certify prod-ready local result`,
      local: clone(localResult),
      camp: clone(campResult),
    });
  }

  if (fidelity === "mocked" && contractResult !== undefined && !sameValue(localResult, contractResult)) {
    return deepFreeze({
      status: "fail",
      code: "HOBO_DEV_MOCK_CONTRACT_DRIFT",
      message: `${name} mock result drifted from contract`,
      diff: {
        local: clone(localResult),
        contract: clone(contractResult),
      },
    });
  }

  if (["real", "simulated"].includes(fidelity) && campResult !== undefined && !sameValue(localResult, campResult)) {
    return deepFreeze({
      status: "fail",
      code: "HOBO_DEV_LOCAL_CAMP_DRIFT",
      message: `${name} local ${fidelity} result differs from Camp evidence`,
      diff: {
        local: clone(localResult),
        camp: clone(campResult),
      },
    });
  }

  return deepFreeze({
    status: "pass",
    code: "HOBO_DEV_LOCAL_CAMP_MATCH",
    message: `${name} local evidence is consistent with declared fidelity`,
  });
}

export function verifyReplayDeterminism({ capability, declaredFidelity, firstRun, replayRun } = {}) {
  const name = requireNonEmptyString(capability, "capability");
  const fidelity = requireFidelity(declaredFidelity ?? "camp-only", "declaredFidelity");

  if (fidelity !== "simulated") {
    return deepFreeze({
      status: "blocked",
      code: "HOBO_DEV_REPLAY_REQUIRES_SIMULATED",
      message: `${name} replay determinism is only a simulated-fidelity claim`,
    });
  }

  if (!sameValue(firstRun, replayRun)) {
    return deepFreeze({
      status: "fail",
      code: "HOBO_DEV_REPLAY_DRIFT",
      message: `${name} replay did not reproduce first-run clock behavior`,
      diff: { firstRun: clone(firstRun), replayRun: clone(replayRun) },
    });
  }

  return deepFreeze({
    status: "pass",
    code: "HOBO_DEV_REPLAY_DETERMINISTIC",
    message: `${name} replay reproduced the first-run clock behavior`,
  });
}

function requireFidelity(value, fieldName) {
  const fidelity = requireNonEmptyString(value, fieldName);
  if (!Object.hasOwn(FIDELITY_RANK, fidelity)) {
    throw new TypeError(`${fieldName} must be one of ${Object.keys(FIDELITY_RANK).join(", ")}`);
  }
  return fidelity;
}

function requireNonEmptyString(value, fieldName) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(toStableValue(left)) === JSON.stringify(toStableValue(right));
}

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone instanceof Function
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function cloneRecord(value) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new TypeError("baseline must be an object");
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) {
    deepFreeze(entry);
  }
  return value;
}

function toStableValue(value) {
  if (Array.isArray(value)) return value.map(toStableValue);
  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, entry]) => [key, toStableValue(entry)])
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  }
  return value;
}
