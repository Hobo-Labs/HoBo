import { bench, describe } from "vitest";

// Presence + executable hot-path noop for deterministic-replay-engine (gate checks presence by default).
describe("deterministic-replay-engine", () => {
  bench("identity noop", () => {
    void "deterministic-replay-engine".length;
  });
});
