import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CompactionRejectedError,
  RetentionFloorError,
  SnapshotIntegrityError,
  createSnapshotCompactionLog,
  foldCounter,
} from "../src/snapshot-compaction-contract.js";

test("actor activation replays only the tail past its snapshot", () => {
  const log = createSnapshotCompactionLog();
  appendCounter(log, "domain.counter/high-volume", [2, 3, 5]);

  log.writeSnapshot("domain.counter/high-volume", {
    fold: foldCounter,
    throughSeq: 3,
  });
  appendCounter(log, "domain.counter/high-volume", [7, 11]);

  const activation = log.activate("domain.counter/high-volume", {
    fold: foldCounter,
  });

  assert.equal(activation.usedSnapshot, true);
  assert.equal(activation.replayedFromSeq, 4);
  assert.deepEqual(activation.replayedEventSeqs, [4, 5]);
  assert.deepEqual(activation.state, { count: 5, total: 28 });
});

test("deleting a snapshot yields identical state via full replay", () => {
  const log = createSnapshotCompactionLog();
  appendCounter(log, "domain.counter/replay", [1, 1, 2, 3, 5]);

  log.writeSnapshot("domain.counter/replay", {
    fold: foldCounter,
    throughSeq: 4,
  });
  const fromSnapshot = log.activate("domain.counter/replay", {
    fold: foldCounter,
  });

  log.deleteSnapshot("domain.counter/replay");
  const fromZero = log.activate("domain.counter/replay", {
    fold: foldCounter,
  });

  assert.equal(fromZero.usedSnapshot, false);
  assert.equal(fromZero.replayedFromSeq, 1);
  assert.deepEqual(fromZero.replayedEventSeqs, [1, 2, 3, 4, 5]);
  assert.deepEqual(fromZero.state, fromSnapshot.state);
});

test("high-volume domain stream snapshot-and-truncates with an audit marker and still rebuilds", () => {
  const log = createSnapshotCompactionLog();
  appendCounter(log, "domain.counter/archive", [4, 6, 8, 10, 12, 14]);

  const marker = log.compactDomainStream("domain.counter/archive", {
    fold: foldCounter,
    retentionFloorSeq: 4,
    throughSeq: 5,
  });

  assert.equal(marker.type, "snapshot-compaction.audit-marker");
  assert.equal(marker.streamId, "domain.counter/archive");
  assert.equal(marker.covers.throughSeq, 5);
  assert.deepEqual(log.activeEvents("domain.counter/archive").map((event) => event.seq), [6]);
  assert.deepEqual(log.coldStorageEvents("domain.counter/archive").map((event) => event.seq), [
    1,
    2,
    3,
    4,
    5,
  ]);
  assert.deepEqual(log.auditMarkers("domain.counter/archive"), [marker]);

  const rebuilt = log.rebuildFromAuthority("domain.counter/archive", {
    fold: foldCounter,
  });
  assert.deepEqual(rebuilt.state, { count: 6, total: 54 });
});

test("token, resource, and policy streams refuse compaction", () => {
  for (const streamId of ["token.session/user-1", "resource.vm/vm-1", "policy.rules/org-1"]) {
    const log = createSnapshotCompactionLog();
    log.append({ streamId, type: "audit.Recorded", data: { amount: 1 } });

    assert.throws(
      () =>
        log.compactDomainStream(streamId, {
          fold: foldCounter,
          retentionFloorSeq: 1,
          throughSeq: 1,
        }),
      CompactionRejectedError,
    );
  }
});

test("snapshot at seq N plus tail from N+1 equals from-zero replay without gaps or double-counts", () => {
  const log = createSnapshotCompactionLog();
  appendCounter(log, "domain.counter/equivalence", [1, 2, 3, 4, 5, 6, 7]);

  log.writeSnapshot("domain.counter/equivalence", {
    fold: foldCounter,
    throughSeq: 4,
  });

  const equivalence = log.assertSnapshotTailEquivalence("domain.counter/equivalence", {
    fold: foldCounter,
  });

  assert.deepEqual(equivalence.snapshotTailSeqs, [5, 6, 7]);
  assert.deepEqual(equivalence.fromSnapshot.state, equivalence.fromZero.state);
  assert.deepEqual(equivalence.fromSnapshot.state, { count: 7, total: 28 });
});

test("corrupt snapshot is detected and ignored instead of trusted", () => {
  const log = createSnapshotCompactionLog();
  appendCounter(log, "domain.counter/corrupt", [10, 20, 30]);

  log.writeSnapshot("domain.counter/corrupt", {
    fold: foldCounter,
    throughSeq: 2,
  });
  log.corruptSnapshot("domain.counter/corrupt", (snapshot) => ({
    ...snapshot,
    state: { count: 2, total: 999 },
  }));

  const activation = log.activate("domain.counter/corrupt", {
    fold: foldCounter,
  });

  assert.equal(activation.usedSnapshot, false);
  assert.equal(activation.ignoredSnapshotReason, "corrupt-snapshot");
  assert.deepEqual(activation.state, { count: 3, total: 60 });
  assert.throws(
    () =>
      log.requireValidSnapshot("domain.counter/corrupt", {
        fold: foldCounter,
      }),
    SnapshotIntegrityError,
  );
});

test("truncation that would breach the retention floor is blocked", () => {
  const log = createSnapshotCompactionLog();
  appendCounter(log, "domain.counter/retention", [1, 2, 3, 4]);

  assert.throws(
    () =>
      log.compactDomainStream("domain.counter/retention", {
        fold: foldCounter,
        retentionFloorSeq: 4,
        throughSeq: 3,
      }),
    RetentionFloorError,
  );
});

test("terminal run streams archive only after the retention window", () => {
  const log = createSnapshotCompactionLog();
  log.append({ streamId: "run.42", type: "run.Started", data: {}, timestamp: 1_000 });
  log.append({ streamId: "run.42", type: "run.StepCompleted", data: { step: "build" }, timestamp: 2_000 });
  log.append({ streamId: "run.42", type: "run.Completed", data: {}, timestamp: 3_000 });

  assert.equal(
    log.archiveTerminalRunStream("run.42", {
      now: 3_500,
      retentionMs: 1_000,
    }).archived,
    false,
  );

  const archived = log.archiveTerminalRunStream("run.42", {
    now: 4_001,
    retentionMs: 1_000,
  });

  assert.equal(archived.archived, true);
  assert.equal(archived.reason, "terminal-retention-expired");
  assert.deepEqual(log.activeEvents("run.42"), []);
  assert.deepEqual(log.coldStorageEvents("run.42").map((event) => event.type), [
    "run.Started",
    "run.StepCompleted",
    "run.Completed",
  ]);
});

function appendCounter(log, streamId, amounts) {
  for (const amount of amounts) {
    log.append({ streamId, type: "counter.Incremented", data: { amount } });
  }
}
