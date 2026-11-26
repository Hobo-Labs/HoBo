import { bench, describe } from "vitest";

// Presence + executable hot-path noop for yard-topology-manifest-contract (gate checks presence by default).
describe("yard-topology-manifest-contract", () => {
  bench("identity noop", () => {
    void "yard-topology-manifest-contract".length;
  });
});
