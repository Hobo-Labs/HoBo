import {
  createFlagChanged,
  createFlagContract
} from "../../flag-event-contract/src/flag-event-contract.js";
import { createFlagRulesetSync } from "../../flag-ruleset-sync-contract/src/flag-ruleset-sync.js";

const actor = Object.freeze({
  kind: "user",
  id: "operator_1",
  tenant: "tenant_a"
});

const betaContext = Object.freeze({
  user: {
    kind: "user",
    id: "user_123",
    tenant: "tenant_a",
    claims: [{ key: "segment", value: "beta" }]
  },
  identity: {
    kind: "service",
    id: "spiffe://tenant-a/camp/prod/bindle/checkout",
    tenant: "tenant_a",
    claims: []
  },
  attributes: []
});

export function createPartitionedFlagConsistencyProbe(options = {}) {
  const sync = createFlagRulesetSync({
    maxDeliveryMs: options.maxDeliveryMs ?? 250
  });
  const events = checkoutFlagEvents();

  async function partitionOneEvaluator() {
    sync.subscribe("edge-partitioned");
    sync.subscribe("edge-healthy");
    sync.append(events.defined);
    sync.append(events.enabled);
    sync.disconnect("edge-partitioned", "stream-partition");
    sync.append(events.disabled);

    return {
      partitioned: await sync.evaluateBoolean(
        "edge-partitioned",
        "checkout.kill-switch",
        false,
        betaContext
      ),
      healthy: await sync.evaluateBoolean("edge-healthy", "checkout.kill-switch", false, betaContext)
    };
  }

  async function compareEqualSeqReplicas() {
    sync.subscribe("edge-left");
    sync.subscribe("edge-right");
    sync.append(events.defined);
    sync.append(events.enabled);

    return {
      left: await sync.evaluateBoolean("edge-left", "checkout.kill-switch", false, betaContext),
      right: await sync.evaluateBoolean("edge-right", "checkout.kill-switch", false, betaContext)
    };
  }

  async function resyncAfterPartition() {
    sync.subscribe("edge-partitioned");
    sync.append(events.defined);
    sync.disconnect("edge-partitioned", "stream-partition");
    sync.append(events.enabled);
    sync.append(events.disabled);

    const resync = sync.reconnect("edge-partitioned", { snapshotSeq: 2 });
    const afterResync = await sync.evaluateBoolean(
      "edge-partitioned",
      "checkout.kill-switch",
      true,
      betaContext
    );

    return {
      resync,
      afterResync,
      resyncedRuleset: sync.status("edge-partitioned").ruleset,
      fullReplayRuleset: sync.fullReplayRuleset()
    };
  }

  function measureKillSwitchPropagation() {
    sync.subscribe("edge-a");
    sync.subscribe("edge-b");
    sync.append(events.defined);
    const delivery = sync.append(events.enabled, { nowMs: 40 });

    return {
      delivered: delivery.delivered,
      withinBound: delivery.delivered.every((entry) => entry.deliveryMs <= (options.maxDeliveryMs ?? 250))
    };
  }

  function rejectClockSkewedSeqClaim() {
    sync.subscribe("edge-claimed");
    sync.append(events.defined);
    sync.append(events.enabled);

    const actualSeq = sync.status("edge-claimed").seq;
    const reportedSeq = 5;

    return validateSeqClaim({ actualSeq, reportedSeq });
  }

  async function slowReplicaDegrades() {
    sync.subscribe("edge-healthy");
    sync.subscribe("edge-slow");
    sync.setBackpressured("edge-slow", true);
    const delivery = sync.append(events.defined);
    sync.append(events.enabled);

    return {
      delivery,
      healthy: await sync.evaluateBoolean("edge-healthy", "checkout.kill-switch", false, betaContext),
      slow: await sync.evaluateBoolean("edge-slow", "checkout.kill-switch", false, betaContext)
    };
  }

  return {
    compareEqualSeqReplicas,
    measureKillSwitchPropagation,
    partitionOneEvaluator,
    rejectClockSkewedSeqClaim,
    resyncAfterPartition,
    slowReplicaDegrades
  };
}

function checkoutFlagEvents() {
  const contract = createFlagContract({
    knownTargetingAttributes: ["user.segment"]
  });
  const defined = contract.flag.boolean("checkout.kill-switch", {
    default: false,
    targeting: [{ attribute: "user.segment", op: "equals", value: "beta" }]
  });
  const enabled = createFlagChanged(defined.ref, {
    from: false,
    to: true,
    actor,
    reason: "incident-kill-switch"
  });
  const disabled = createFlagChanged(defined.ref, {
    from: true,
    to: false,
    actor,
    reason: "operator-clear"
  });

  return {
    defined: { seq: 1, event: defined.event, emittedAtMs: 0 },
    enabled: { seq: 2, event: enabled, emittedAtMs: 10 },
    disabled: { seq: 3, event: disabled, emittedAtMs: 20 }
  };
}

function validateSeqClaim({ actualSeq, reportedSeq }) {
  if (reportedSeq > actualSeq) {
    return {
      accepted: false,
      actualSeq,
      reportedSeq,
      reason: `reported seq ${reportedSeq} is higher than held seq ${actualSeq}`
    };
  }

  return {
    accepted: true,
    actualSeq,
    reportedSeq,
    reason: "seq claim matches held state"
  };
}
