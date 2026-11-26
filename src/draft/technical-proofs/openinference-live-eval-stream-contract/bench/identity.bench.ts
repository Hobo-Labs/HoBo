import { bench, describe } from "vitest";

// Presence + executable hot-path noop for openinference-live-eval-stream-contract (gate checks presence by default).
describe("openinference-live-eval-stream-contract", () => {
  bench("identity noop", () => {
    void "openinference-live-eval-stream-contract".length;
  });
});
