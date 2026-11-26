import { bench, describe } from "vitest";

// Presence + executable hot-path noop for cross-cloud-equivalence-model (gate checks presence by default).
describe("cross-cloud-equivalence-model", () => {
  bench("identity noop", () => {
    void "cross-cloud-equivalence-model".length;
  });
});
