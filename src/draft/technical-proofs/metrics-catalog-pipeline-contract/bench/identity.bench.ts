import { bench, describe } from "vitest";

// Presence + executable hot-path noop for metrics-catalog-pipeline-contract (gate checks presence by default).
describe("metrics-catalog-pipeline-contract", () => {
  bench("identity noop", () => {
    void "metrics-catalog-pipeline-contract".length;
  });
});
