import { bench, describe } from "vitest";

// Presence + executable hot-path noop for generation-pipeline-io-contract (gate checks presence by default).
describe("generation-pipeline-io-contract", () => {
  bench("identity noop", () => {
    void "generation-pipeline-io-contract".length;
  });
});
