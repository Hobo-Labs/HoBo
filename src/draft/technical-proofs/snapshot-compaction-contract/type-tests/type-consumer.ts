import {
  createSnapshotCompactionLog,
  foldCounter,
  type SnapshotActivation,
  type SnapshotCompactionLog,
} from "../src/snapshot-compaction-contract.js";

const log: SnapshotCompactionLog = createSnapshotCompactionLog();

log.append({
  streamId: "domain.counter/types",
  type: "counter.Incremented",
  data: { amount: 1 },
});
log.writeSnapshot("domain.counter/types", {
  fold: foldCounter,
  throughSeq: 1,
});

const activation: SnapshotActivation<{ count: number; total: number }> = log.activate(
  "domain.counter/types",
  {
    fold: foldCounter,
  },
);

activation.state.total.toFixed(0);
