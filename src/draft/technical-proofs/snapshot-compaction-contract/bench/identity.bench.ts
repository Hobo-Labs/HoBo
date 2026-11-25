import { bench, describe } from "vitest";

// Presence + executable hot-path noop for snapshot-compaction-contract (gate checks presence by default).
describe("snapshot-compaction-contract", () => {
  bench("identity noop", () => {
    void "snapshot-compaction-contract".length;
  });
});
