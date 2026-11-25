import { bench, describe } from "vitest";

// Presence + executable hot-path noop for evals-training-promotion-gates-poc (gate checks presence by default).
describe("evals-training-promotion-gates-poc", () => {
  bench("identity noop", () => {
    void "evals-training-promotion-gates-poc".length;
  });
});
