import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createFlagChanged,
  createFlagContract,
  createFlagEvaluated
} from "../../flag-event-contract/src/flag-event-contract.js";
import {
  analyzeFlagDebt,
  confirmArchiveProposal,
  evaluateArchivedFlag,
  listActiveFlags,
  replayFlagDebtEvents,
  restoreArchivedFlag
} from "../src/flag-debt-auto-cleanup.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date("2026-06-27T12:00:00.000Z");
const staleWindowMs = 30 * DAY_MS;

const actor = Object.freeze({
  kind: "user",
  id: "flag-admin",
  tenant: "tenant-a"
});

function at(daysAgo) {
  return new Date(now.getTime() - daysAgo * DAY_MS).toISOString();
}

function entry(event, daysAgo, seq) {
  return { event, occurredAt: at(daysAgo), seq };
}

test("flags with no sampled evaluations are proposed for archival after the stale window", () => {
  const contract = createFlagContract();
  const declared = contract.flag.boolean("checkout.dead-path", { default: false });

  const result = analyzeFlagDebt({
    events: [entry(declared.event, 45, 1)],
    now,
    staleWindowMs
  });

  assert.deepEqual(result.proposals, [
    {
      flagKey: "checkout.dead-path",
      reason: "zero-evaluations",
      recommendedAction: "archive-proposal",
      sampledEvaluations: 0,
      references: []
    }
  ]);
});

test("flags constant at 100 percent or 0 percent for the window are proposed for archival", () => {
  const contract = createFlagContract();
  const declared = contract.flag.boolean("checkout.always-on", { default: false });
  const changed = createFlagChanged(declared.ref, {
    from: false,
    to: true,
    actor
  });

  const result = analyzeFlagDebt({
    events: [
      entry(declared.event, 60, 1),
      entry(changed, 60, 2),
      entry(
        createFlagEvaluated(declared.ref, {
          sampled: true,
          value: true,
          reason: "static",
          variant: "on"
        }),
        30,
        3
      ),
      entry(
        createFlagEvaluated(declared.ref, {
          sampled: true,
          value: true,
          reason: "static",
          variant: "on"
        }),
        1,
        4
      )
    ],
    now,
    staleWindowMs
  });

  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].flagKey, "checkout.always-on");
  assert.equal(result.proposals[0].reason, "constant-terminal-value");
  assert.equal(result.proposals[0].terminalValue, true);
});

test("archival emits flag.Archived, hides active listings, and preserves replayable history", () => {
  const contract = createFlagContract();
  const declared = contract.flag.boolean("checkout.dead-path", { default: false });
  const archive = confirmArchiveProposal({
    events: [entry(declared.event, 45, 1)],
    flagKey: "checkout.dead-path",
    actor,
    reason: "stale-flag-cleanup",
    occurredAt: now
  });

  assert.equal(archive.event.type, "flag.Archived");
  assert.equal(archive.event.data.archived, true);

  const state = replayFlagDebtEvents([
    entry(declared.event, 45, 1),
    { event: archive.event, occurredAt: now.toISOString(), seq: 2 }
  ]);

  assert.deepEqual(listActiveFlags(state), []);
  assert.equal(state.flags["checkout.dead-path"].archived, true);
  assert.equal(state.history["checkout.dead-path"].length, 2);
  assert.equal(state.history["checkout.dead-path"][1].type, "flag.Archived");
});

test("actively targeted flags are never stale even when observed values are constant", () => {
  const contract = createFlagContract({
    knownTargetingAttributes: ["user.segment"]
  });
  const declared = contract.flag.boolean("checkout.beta", {
    default: false,
    targeting: [{ attribute: "user.segment", op: "equals", value: "beta" }]
  });
  const changed = createFlagChanged(declared.ref, {
    from: false,
    to: true,
    actor
  });

  const result = analyzeFlagDebt({
    events: [
      entry(declared.event, 60, 1),
      entry(changed, 60, 2),
      entry(
        createFlagEvaluated(declared.ref, {
          sampled: true,
          value: true,
          reason: "targeting-match",
          variant: "beta"
        }),
        30,
        3
      ),
      entry(
        createFlagEvaluated(declared.ref, {
          sampled: true,
          value: true,
          reason: "targeting-match",
          variant: "beta"
        }),
        1,
        4
      )
    ],
    now,
    staleWindowMs
  });

  assert.deepEqual(result.proposals, []);
  assert.deepEqual(result.activeFlags, ["checkout.beta"]);
});

test("variant-dependent evaluations are not proposed as stale terminal flags", () => {
  const contract = createFlagContract();
  const declared = contract.flag.boolean("checkout.variant", { default: false });
  const changed = createFlagChanged(declared.ref, {
    from: false,
    to: true,
    actor
  });

  const result = analyzeFlagDebt({
    events: [
      entry(declared.event, 60, 1),
      entry(changed, 60, 2),
      entry(
        createFlagEvaluated(declared.ref, {
          sampled: true,
          value: true,
          reason: "static",
          variant: "beta"
        }),
        30,
        3
      ),
      entry(
        createFlagEvaluated(declared.ref, {
          sampled: true,
          value: true,
          reason: "static",
          variant: "beta"
        }),
        1,
        4
      )
    ],
    now,
    staleWindowMs
  });

  assert.deepEqual(result.proposals, []);
  assert.equal(result.diagnostics["checkout.variant"].status, "actively-targeted");
});

test("low-traffic genuine flags are not archived purely from sparse sampled evaluations", () => {
  const contract = createFlagContract();
  const declared = contract.flag.boolean("checkout.low-traffic", { default: false });

  const result = analyzeFlagDebt({
    events: [
      entry(declared.event, 60, 1),
      entry(
        createFlagEvaluated(declared.ref, {
          sampled: true,
          value: false,
          reason: "static",
          variant: "off"
        }),
        1,
        2
      )
    ],
    minSampledEvaluations: 3,
    now,
    staleWindowMs
  });

  assert.deepEqual(result.proposals, []);
  assert.equal(
    result.diagnostics["checkout.low-traffic"].status,
    "insufficient-sampling"
  );
});

test("archived flags referenced by live code surface references and return labeled last values", () => {
  const contract = createFlagContract();
  const declared = contract.flag.boolean("checkout.dead-branch", { default: false });
  const changed = createFlagChanged(declared.ref, {
    from: false,
    to: true,
    actor
  });
  const references = {
    "checkout.dead-branch": [
      {
        file: "src/checkout.ts",
        line: 42,
        branch: "if (flags.checkout.deadBranch)"
      }
    ]
  };
  const archive = confirmArchiveProposal({
    codeReferences: references,
    events: [entry(declared.event, 45, 1), entry(changed, 44, 2)],
    flagKey: "checkout.dead-branch",
    actor,
    occurredAt: now
  });
  const state = replayFlagDebtEvents([
    entry(declared.event, 45, 1),
    entry(changed, 44, 2),
    { event: archive.event, occurredAt: now.toISOString(), seq: 3 }
  ]);

  assert.deepEqual(archive.references, references["checkout.dead-branch"]);

  const details = evaluateArchivedFlag({
    state,
    flagKey: "checkout.dead-branch",
    defaultValue: false,
    codeReferences: references
  });

  assert.equal(details.value, true);
  assert.equal(details.reason, "archived:last-known");
  assert.equal(details.archived, true);
  assert.deepEqual(details.references, references["checkout.dead-branch"]);
});

test("unarchiving is reversible and keeps the audit trail", () => {
  const contract = createFlagContract();
  const declared = contract.flag.boolean("checkout.reversible", { default: false });
  const archive = confirmArchiveProposal({
    events: [entry(declared.event, 45, 1)],
    flagKey: "checkout.reversible",
    actor,
    occurredAt: now
  });
  const restore = restoreArchivedFlag({
    events: [
      entry(declared.event, 45, 1),
      { event: archive.event, occurredAt: now.toISOString(), seq: 2 }
    ],
    flagKey: "checkout.reversible",
    actor,
    reason: "reactivated",
    occurredAt: new Date(now.getTime() + DAY_MS)
  });
  const state = replayFlagDebtEvents([
    entry(declared.event, 45, 1),
    { event: archive.event, occurredAt: now.toISOString(), seq: 2 },
    {
      event: restore.event,
      occurredAt: new Date(now.getTime() + DAY_MS).toISOString(),
      seq: 3
    }
  ]);

  assert.equal(restore.event.type, "flag.Archived");
  assert.equal(restore.event.data.archived, false);
  assert.deepEqual(listActiveFlags(state), ["checkout.reversible"]);
  assert.deepEqual(
    state.history["checkout.reversible"].map((event) => event.type),
    ["flag.Defined", "flag.Archived", "flag.Archived"]
  );
});
