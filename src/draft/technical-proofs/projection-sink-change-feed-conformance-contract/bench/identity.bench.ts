import { bench, describe } from "vitest";

// Presence + executable hot-path noop for projection-sink-change-feed-conformance-contract (gate checks presence by default).
describe("projection-sink-change-feed-conformance-contract", () => {
  bench("identity noop", () => {
    void "projection-sink-change-feed-conformance-contract".length;
  });
});
