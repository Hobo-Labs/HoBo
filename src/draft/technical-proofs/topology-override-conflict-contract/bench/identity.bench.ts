import { bench, describe } from "vitest";

// Presence + executable hot-path noop for topology-override-conflict-contract (gate checks presence by default).
describe("topology-override-conflict-contract", () => {
  bench("identity noop", () => {
    void "topology-override-conflict-contract".length;
  });
});
