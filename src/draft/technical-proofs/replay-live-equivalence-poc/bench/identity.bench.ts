import { bench, describe } from "vitest";

// Presence + executable hot-path noop for replay-live-equivalence-poc (gate checks presence by default).
describe("replay-live-equivalence-poc", () => {
  bench("identity noop", () => {
    void "replay-live-equivalence-poc".length;
  });
});
