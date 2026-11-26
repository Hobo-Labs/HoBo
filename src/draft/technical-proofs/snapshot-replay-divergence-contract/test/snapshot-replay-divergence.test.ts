import assert from "node:assert/strict";
import { test } from "vitest";

import {
  SnapshotDivergenceError,
  SnapshotRejectedError,
  activateFromSnapshot,
  assertSnapshotMatchesReplayAcrossBoundaries,
  createSnapshot,
  foldMailbox,
  replayFromZero,
} from "../src/snapshot-replay-divergence-contract.js";

const baseContract = Object.freeze({
  contractVersion: "hobo.snapshot-replay-divergence/v1",
  foldVersion: "mailbox-fold/v1",
  upcasterVersion: "mailbox-upcaster/v1",
  erasureEpoch: "forgetting-keys/v1",
});

test("snapshot-folded state equals from-zero replay across fuzzed seq boundaries", () => {
  const events = mailboxEvents([
    ["ticket.Opened", { id: "t1", title: "one", priority: 1 }],
    ["ticket.PriorityChanged", { id: "t1", priority: 2 }],
    ["ticket.Opened", { id: "t2", title: "two", priority: 4 }],
    ["ticket.Closed", { id: "t1" }],
    ["ticket.PriorityChanged", { id: "t2", priority: 5 }],
  ]);

  const proof = assertSnapshotMatchesReplayAcrossBoundaries({
    events,
    fold: foldMailbox,
    contract: baseContract,
    boundaries: [0, 1, 2, 3, 4, 5],
  });

  assert.equal(proof.checkedBoundaries, 6);
  assert.deepEqual(proof.finalState, {
    open: {
      t2: { id: "t2", priority: 5, title: "two" },
    },
    closed: ["t1"],
    quarantined: [],
  });
});

test("snapshot stale after a fold or upcaster change is invalidated and full replay wins", () => {
  const events = mailboxEvents([
    ["ticket.Opened", { id: "t1", summary: "legacy", priority: 1, v: 1 }],
    ["ticket.PriorityChanged", { id: "t1", priority: 3 }],
  ]);
  const snapshot = createSnapshot({
    events,
    throughSeq: 1,
    fold: foldMailbox,
    contract: baseContract,
  });

  const currentContract = {
    ...baseContract,
    upcasterVersion: "mailbox-upcaster/v2",
  };
  const activated = activateFromSnapshot({
    events,
    snapshot,
    fold: foldMailbox,
    contract: currentContract,
  });

  assert.equal(activated.usedSnapshot, false);
  assert.equal(activated.ignoredSnapshotReason, "upcaster-version-changed");
  assert.deepEqual(activated.state, replayFromZero({ events, fold: foldMailbox, contract: currentContract }).state);
});

test("corrupt snapshot is ignored instead of trusted", () => {
  const events = mailboxEvents([
    ["ticket.Opened", { id: "t1", title: "one", priority: 1 }],
    ["ticket.PriorityChanged", { id: "t1", priority: 9 }],
  ]);
  const snapshot = createSnapshot({
    events,
    throughSeq: 1,
    fold: foldMailbox,
    contract: baseContract,
  });
  const corruptSnapshot = {
    ...snapshot,
    state: { open: { t1: { id: "t1", priority: 999, title: "forged" } }, closed: [], quarantined: [] },
  };

  const activated = activateFromSnapshot({
    events,
    snapshot: corruptSnapshot,
    fold: foldMailbox,
    contract: baseContract,
  });

  assert.equal(activated.usedSnapshot, false);
  assert.equal(activated.ignoredSnapshotReason, "snapshot-digest-mismatch");
  assert.deepEqual(activated.state.open.t1, { id: "t1", priority: 9, title: "one" });
});

test("pre-erasure snapshot is invalidated so shredded content cannot resurrect", () => {
  const events = mailboxEvents([
    ["ticket.Opened", { id: "t1", title: "pii", priority: 1, requesterCiphertext: "alice@example.test" }],
  ]);
  const beforeErasure = {
    ...baseContract,
    erasureEpoch: "forgetting-keys/before-shred",
  };
  const snapshot = createSnapshot({
    events,
    throughSeq: 1,
    fold: foldMailbox,
    contract: beforeErasure,
    forgettingKeys: { requester: true },
  });

  const afterErasure = {
    ...baseContract,
    erasureEpoch: "forgetting-keys/after-shred",
  };
  const activated = activateFromSnapshot({
    events,
    snapshot,
    fold: foldMailbox,
    contract: afterErasure,
    forgettingKeys: { requester: false },
  });

  assert.equal(activated.usedSnapshot, false);
  assert.equal(activated.ignoredSnapshotReason, "erasure-epoch-changed");
  assert.equal(activated.state.open.t1.requester, "[shredded]");
});

test("snapshot whose covering seq is ahead of the stream is rejected", () => {
  const events = mailboxEvents([["ticket.Opened", { id: "t1", title: "one", priority: 1 }]]);
  const impossibleFuture = {
    ...createSnapshot({
      events,
      throughSeq: 1,
      fold: foldMailbox,
      contract: baseContract,
    }),
    throughSeq: 5,
  };

  assert.throws(
    () =>
      activateFromSnapshot({
        events,
        snapshot: impossibleFuture,
        fold: foldMailbox,
        contract: baseContract,
      }),
    SnapshotRejectedError,
  );
});

test("fold logic change without a snapshot version bump is caught before trust", () => {
  const events = mailboxEvents([
    ["ticket.Opened", { id: "t1", title: "one", priority: 1 }],
    ["ticket.PriorityChanged", { id: "t1", priority: 5 }],
  ]);
  const snapshot = createSnapshot({
    events,
    throughSeq: 1,
    fold: foldMailbox,
    contract: baseContract,
  });
  const changedFold = (state, event, context) => {
    const next = foldMailbox(state, event, context);
    if (event?.type === "ticket.Opened" && next.open[event.data.id]) {
      next.open[event.data.id].priority += 10;
    }
    return next;
  };

  const activated = activateFromSnapshot({
    events,
    snapshot,
    fold: changedFold,
    contract: baseContract,
  });

  assert.equal(activated.usedSnapshot, false);
  assert.equal(activated.ignoredSnapshotReason, "snapshot-prefix-diverged");
  assert.throws(
    () =>
      activateFromSnapshot({
        events,
        snapshot,
        fold: changedFold,
        contract: baseContract,
        failOnDivergence: true,
      }),
    SnapshotDivergenceError,
  );
});

test("snapshot taken mid-quarantine reflects the same deterministic skip as replay", () => {
  const events = mailboxEvents([
    ["ticket.Opened", { id: "t1", title: "one", priority: 1 }],
    ["ticket.Opened", { id: "poison", title: "bad", priority: Number.NaN }],
    ["ticket.PriorityChanged", { id: "t1", priority: 2 }],
  ]);
  const quarantine = [{ seq: 2, reason: "priority must be finite" }];
  const snapshot = createSnapshot({
    events,
    throughSeq: 2,
    fold: foldMailbox,
    contract: baseContract,
    quarantine,
  });

  const activated = activateFromSnapshot({
    events,
    snapshot,
    fold: foldMailbox,
    contract: baseContract,
    quarantine,
  });
  const replayed = replayFromZero({
    events,
    fold: foldMailbox,
    contract: baseContract,
    quarantine,
  });

  assert.equal(activated.usedSnapshot, true);
  assert.deepEqual(activated.state, replayed.state);
  assert.deepEqual(activated.state.quarantined, [{ reason: "priority must be finite", seq: 2 }]);
});

function mailboxEvents(entries) {
  return entries.map(([type, data], index) => ({
    data,
    id: `evt-${index + 1}`,
    seq: index + 1,
    streamId: "mailbox/team-a",
    type,
  }));
}
