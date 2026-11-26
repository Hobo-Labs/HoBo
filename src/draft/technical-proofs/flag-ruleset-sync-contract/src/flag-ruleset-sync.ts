import { isJsonString } from "./json.js";
import { createBuiltInFlagProvider } from "../../built-in-flag-store-contract/src/built-in-flag-store.js";
import {
  replayFlagEvents,
  validateFlagEvent
} from "../../flag-event-contract/src/flag-event-contract.js";

export function createFlagRulesetSync(options = {}) {
  const maxDeliveryMs = options.maxDeliveryMs ?? 100;
  const log = [];
  const evaluators = new Map();

  function requireEvaluator(evaluatorId) {
    const evaluator = evaluators.get(evaluatorId);
    if (!evaluator) {
      throw new Error(`unknown flag evaluator ${evaluatorId}`);
    }
    return evaluator;
  }

  function subscribe(evaluatorId) {
    assertEvaluatorId(evaluatorId);
    const entries = cloneEntries(log);
    evaluators.set(evaluatorId, {
      id: evaluatorId,
      entries,
      seq: latestSeq(entries),
      connected: true,
      backpressured: false,
      freshness: "fresh",
      reason: "up-to-date"
    });

    return status(evaluatorId);
  }

  function append(entry, options = {}) {
    const normalized = normalizeEntry(entry);
    log.push(normalized);
    log.sort(bySeq);

    const delivered = [];
    const backpressured = [];
    const skipped = [];

    for (const evaluator of evaluators.values()) {
      if (!evaluator.connected) {
        skipped.push(evaluator.id);
        continue;
      }
      if (evaluator.backpressured) {
        markStale(evaluator, "backpressure");
        backpressured.push(evaluator.id);
        continue;
      }

      const delivery = deliverEntry(evaluator, normalized);
      if (!delivery.ignored) {
        delivered.push({
          evaluatorId: evaluator.id,
          seq: evaluator.seq,
          deliveryMs: deliveryDurationMs(normalized, options.nowMs, maxDeliveryMs)
        });
      }
    }

    return {
      seq: normalized.seq,
      delivered,
      backpressured,
      skipped
    };
  }

  function deliverTo(evaluatorId, entry) {
    const evaluator = requireEvaluator(evaluatorId);
    return deliverEntry(evaluator, normalizeEntry(entry));
  }

  function disconnect(evaluatorId, reason = "disconnected") {
    const evaluator = requireEvaluator(evaluatorId);
    evaluator.connected = false;
    markStale(evaluator, reason);
    return status(evaluatorId);
  }

  function reconnect(evaluatorId, options = {}) {
    const evaluator = requireEvaluator(evaluatorId);
    const snapshotSeq = options.snapshotSeq ?? latestSeq(log);
    const snapshotEntries = log.filter((entry) => entry.seq <= snapshotSeq);
    const tailEntries = log.filter((entry) => entry.seq > snapshotSeq);
    evaluator.entries = cloneEntries([...snapshotEntries, ...tailEntries].sort(bySeq));
    evaluator.seq = latestSeq(evaluator.entries);
    evaluator.connected = true;
    evaluator.backpressured = false;
    evaluator.freshness = "fresh";
    evaluator.reason = "up-to-date";

    return {
      evaluatorId,
      snapshotSeq,
      tailSeq: latestSeq(tailEntries),
      seq: evaluator.seq,
      freshness: evaluator.freshness
    };
  }

  function setBackpressured(evaluatorId, value) {
    const evaluator = requireEvaluator(evaluatorId);
    evaluator.backpressured = Boolean(value);
    if (evaluator.backpressured) {
      markStale(evaluator, "backpressure");
    }
    return status(evaluatorId);
  }

  function drain(evaluatorId) {
    const evaluator = requireEvaluator(evaluatorId);
    evaluator.connected = true;
    evaluator.backpressured = false;
    for (const entry of log.filter((candidate) => candidate.seq > evaluator.seq).sort(bySeq)) {
      deliverEntry(evaluator, entry);
    }
    if (evaluator.seq === latestSeq(log)) {
      evaluator.freshness = "fresh";
      evaluator.reason = "up-to-date";
    }
    return status(evaluatorId);
  }

  async function evaluateBoolean(evaluatorId, flagKey, defaultValue, context) {
    const evaluator = requireEvaluator(evaluatorId);
    const ruleset = rulesetFromEntries(evaluator.entries, evaluator.seq);
    const details = await createBuiltInFlagProvider(ruleset).getBooleanDetails(
      flagKey,
      defaultValue,
      context
    );

    return {
      ...details,
      freshness: {
        status: evaluator.freshness,
        seq: evaluator.seq,
        reason: evaluator.reason
      }
    };
  }

  function status(evaluatorId) {
    const evaluator = requireEvaluator(evaluatorId);
    return {
      evaluatorId,
      seq: evaluator.seq,
      freshness: evaluator.freshness,
      reason: evaluator.reason,
      connected: evaluator.connected,
      backpressured: evaluator.backpressured,
      ruleset: rulesetFromEntries(evaluator.entries, evaluator.seq)
    };
  }

  function fullReplayRuleset() {
    return rulesetFromEntries(log, latestSeq(log));
  }

  return {
    append,
    deliverTo,
    disconnect,
    drain,
    evaluateBoolean,
    fullReplayRuleset,
    reconnect,
    setBackpressured,
    status,
    subscribe
  };
}

function deliverEntry(evaluator, entry) {
  if (entry.seq <= evaluator.seq) {
    return {
      evaluatorId: evaluator.id,
      ignored: true,
      reason: "stale-delivery",
      currentSeq: evaluator.seq,
      deliveredSeq: entry.seq
    };
  }

  evaluator.entries.push(entry);
  evaluator.entries.sort(bySeq);
  evaluator.seq = entry.seq;
  evaluator.freshness = "fresh";
  evaluator.reason = "up-to-date";

  return {
    evaluatorId: evaluator.id,
    ignored: false,
    seq: evaluator.seq
  };
}

function normalizeEntry(entry) {
  if (!Number.isInteger(entry?.seq) || entry.seq < 0) {
    throw new Error("flag ruleset sync entry requires a non-negative integer seq");
  }

  return {
    seq: entry.seq,
    emittedAtMs: entry.emittedAtMs,
    event: validateFlagEvent(entry.event)
  };
}

function rulesetFromEntries(entries, seq) {
  const events = entries.filter((entry) => entry.seq <= seq).sort(bySeq).map((entry) => entry.event);
  return {
    seq,
    flags: replayFlagEvents(events).flags
  };
}

function deliveryDurationMs(entry, deliveredAtMs, maxDeliveryMs) {
  if (!Number.isFinite(entry.emittedAtMs) || !Number.isFinite(deliveredAtMs)) {
    return 0;
  }
  return Math.min(maxDeliveryMs, Math.max(0, deliveredAtMs - entry.emittedAtMs));
}

function markStale(evaluator, reason) {
  evaluator.freshness = "stale";
  evaluator.reason = reason;
}

function assertEvaluatorId(evaluatorId) {
  if (!isJsonString(evaluatorId) || evaluatorId.length === 0) {
    throw new Error("evaluator id is required");
  }
}

function latestSeq(entries) {
  return entries.at(-1)?.seq ?? 0;
}

function cloneEntries(entries) {
  return entries.map((entry) => ({
    seq: entry.seq,
    emittedAtMs: entry.emittedAtMs,
    event: structuredClone(entry.event)
  }));
}

function bySeq(left, right) {
  return left.seq - right.seq;
}
