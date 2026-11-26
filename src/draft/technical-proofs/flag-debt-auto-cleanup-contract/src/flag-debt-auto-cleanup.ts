import { isJsonString } from "./json.js";
import {
  createFlagArchived,
  validateFlagEvent
} from "../../flag-event-contract/src/flag-event-contract.js";

const DEFAULT_MIN_SAMPLED_EVALUATIONS = 2;

export function analyzeFlagDebt({
  codeReferences = {},
  events = [],
  minSampledEvaluations = DEFAULT_MIN_SAMPLED_EVALUATIONS,
  now = new Date(),
  staleWindowMs
} = {}) {
  const nowMs = toTimeMs(now, "now");
  const windowMs = requiredPositiveNumber(staleWindowMs, "staleWindowMs");
  const windowStartMs = nowMs - windowMs;
  const state = replayFlagDebtEvents(events);
  const proposals = [];
  const diagnostics = {};

  for (const flagKey of Object.keys(state.flags).sort()) {
    const flag = state.flags[flagKey];
    const evaluations = state.evaluations[flagKey] ?? [];
    const windowEvaluations = evaluations.filter((entry) => entry.occurredAtMs >= windowStartMs);
    const references = referencesFor(codeReferences, flagKey);

    if (flag.archived) {
      diagnostics[flagKey] = { status: "already-archived" };
      continue;
    }

    if (isActivelyTargeted(flag, windowEvaluations)) {
      diagnostics[flagKey] = { status: "actively-targeted" };
      continue;
    }

    if (evaluations.length === 0) {
      if (flag.definedAtMs <= windowStartMs) {
        proposals.push({
          flagKey,
          reason: "zero-evaluations",
          recommendedAction: "archive-proposal",
          sampledEvaluations: 0,
          references
        });
        diagnostics[flagKey] = { status: "stale" };
      } else {
        diagnostics[flagKey] = { status: "too-new" };
      }
      continue;
    }

    if (windowEvaluations.length < minSampledEvaluations) {
      diagnostics[flagKey] = {
        status: "insufficient-sampling",
        sampledEvaluations: windowEvaluations.length
      };
      continue;
    }

    const values = windowEvaluations.map((entry) => entry.event.data.value);
    const firstValue = values[0];
    if (
      isTerminalFlagValue(firstValue) &&
      values.every((value) => sameJson(value, firstValue))
    ) {
      proposals.push({
        flagKey,
        reason: "constant-terminal-value",
        recommendedAction: "archive-proposal",
        sampledEvaluations: windowEvaluations.length,
        terminalValue: cloneJson(firstValue),
        references
      });
      diagnostics[flagKey] = { status: "stale" };
      continue;
    }

    diagnostics[flagKey] = { status: "active" };
  }

  return {
    activeFlags: listActiveFlags(state),
    diagnostics,
    proposals
  };
}

export function confirmArchiveProposal({
  codeReferences = {},
  events = [],
  flagKey,
  actor,
  reason = "stale-flag-cleanup",
  occurredAt = new Date()
} = {}) {
  const state = replayFlagDebtEvents(events);
  const flag = requireFlag(state, flagKey);
  if (flag.archived) {
    throw new Error(`flag ${flagKey} is already archived`);
  }

  return {
    event: createArchiveEvent(flag, {
      actor,
      archived: true,
      occurredAt,
      reason
    }),
    references: referencesFor(codeReferences, flagKey)
  };
}

export function restoreArchivedFlag({
  events = [],
  flagKey,
  actor,
  reason = "restored",
  occurredAt = new Date()
} = {}) {
  const state = replayFlagDebtEvents(events);
  const flag = requireFlag(state, flagKey);
  if (!flag.archived) {
    throw new Error(`flag ${flagKey} is not archived`);
  }

  return {
    event: createArchiveEvent(flag, {
      actor,
      archived: false,
      occurredAt,
      reason
    })
  };
}

export function replayFlagDebtEvents(events = []) {
  const entries = normalizeEntries(events);
  const state = {
    evaluations: {},
    flags: {},
    history: {}
  };

  for (const entry of entries) {
    const { event } = entry;
    const key = event.data.key;
    state.history[key] ??= [];
    state.history[key].push(event);

    switch (event.type) {
      case "flag.Defined":
        state.flags[key] = {
          key,
          archived: state.flags[key]?.archived ?? false,
          currentValue: cloneJson(state.flags[key]?.currentValue ?? event.data.defaultValue),
          defaultValue: cloneJson(event.data.defaultValue),
          definedAt: entry.occurredAt,
          definedAtMs: entry.occurredAtMs,
          targeting: cloneJson(event.data.targeting ?? []),
          valueType: event.data.valueType
        };
        break;
      case "flag.Changed": {
        const flag = requireFlag(state, key);
        if (flag.valueType !== event.data.valueType) {
          throw new Error(`flag.Changed value type mismatch for ${key}`);
        }
        if (event.data.diff.value) {
          flag.currentValue = cloneJson(event.data.diff.value.to);
        }
        if (event.data.diff.targeting) {
          flag.targeting = cloneJson(event.data.diff.targeting.to);
        }
        break;
      }
      case "flag.Evaluated":
        requireFlag(state, key);
        state.evaluations[key] ??= [];
        state.evaluations[key].push(entry);
        break;
      case "flag.Archived":
        requireFlag(state, key).archived = event.data.archived !== false;
        break;
    }
  }

  return state;
}

export function listActiveFlags(state) {
  return Object.keys(state?.flags )
    .filter((flagKey) => state.flags[flagKey].archived !== true)
    .sort();
}

export function evaluateArchivedFlag({
  codeReferences = {},
  defaultValue,
  flagKey,
  state
} = {}) {
  const flag = requireFlag(state, flagKey);
  if (!flag.archived) {
    return {
      flagKey,
      value: cloneJson(flag.currentValue),
      reason: "active",
      archived: false,
      references: referencesFor(codeReferences, flagKey)
    };
  }

  const hasLastValue = flag.currentValue !== undefined;
  return {
    flagKey,
    value: cloneJson(hasLastValue ? flag.currentValue : defaultValue),
    reason: hasLastValue ? "archived:last-known" : "archived:default",
    archived: true,
    references: referencesFor(codeReferences, flagKey)
  };
}

function createArchiveEvent(flag, { actor, archived, occurredAt, reason }) {
  const event = createFlagArchived(
    { key: flag.key, type: flag.valueType },
    { actor, reason }
  );
  event.data.archived = archived;
  event.data.occurredAt = toIso(occurredAt, "occurredAt");

  return validateFlagEvent(event);
}

function normalizeEntries(events) {
  if (!Array.isArray(events)) {
    throw new TypeError("events must be an array");
  }

  return events
    .map((entry, index) => {
      const event = validateFlagEvent(entry?.event ?? entry);
      const occurredAt = entry?.occurredAt ?? event.data?.occurredAt ?? event.occurredAt;
      const occurredAtMs = toTimeMs(occurredAt, "occurredAt");

      return {
        event,
        index,
        occurredAt: new Date(occurredAtMs).toISOString(),
        occurredAtMs,
        seq: entry?.seq ?? index
      };
    })
    .sort((left, right) => left.seq - right.seq || left.index - right.index);
}

function requireFlag(state, flagKey) {
  if (!isJsonString(flagKey) || flagKey.length === 0) {
    throw new TypeError("flagKey is required");
  }
  const flag = state?.flags?.[flagKey];
  if (!flag) {
    throw new Error(`flag ${flagKey} must be defined`);
  }
  return flag;
}

function isActivelyTargeted(flag, evaluations) {
  return (
    (flag.targeting ?? []).length > 0 ||
    evaluations.some((entry) => isVariantDependentEvaluation(entry.event))
  );
}

function isVariantDependentEvaluation(event) {
  return (
    event.data.reason === "targeting-match" ||
    (isJsonString(event.data.variant) &&
      !["default", "off", "on", "selected"].includes(event.data.variant))
  );
}

function isTerminalFlagValue(value) {
  return value === true || value === false || value === 0 || value === 100;
}

function referencesFor(codeReferences, flagKey) {
  return cloneJson(codeReferences?.[flagKey] ?? []);
}

function requiredPositiveNumber(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive number`);
  }
  return value;
}

function toIso(value, label) {
  return new Date(toTimeMs(value, label)).toISOString();
}

function toTimeMs(value, label) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new TypeError(`${label} must be a valid timestamp`);
  }
  return ms;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneJson(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}
