import { bench, describe } from "vitest";

// Presence + executable hot-path noop for experiment-statistical-analysis-contract (gate checks presence by default).
describe("experiment-statistical-analysis-contract", () => {
  bench("identity noop", () => {
    void "experiment-statistical-analysis-contract".length;
  });
});
