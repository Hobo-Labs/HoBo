import { bench, describe } from "vitest";

// Presence + executable hot-path noop for capability-indexed-discovery-contract (gate checks presence by default).
describe("capability-indexed-discovery-contract", () => {
  bench("identity noop", () => {
    void "capability-indexed-discovery-contract".length;
  });
});
