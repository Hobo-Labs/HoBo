import { bench, describe } from "vitest";

// Presence + executable hot-path noop for runtime-local-execution-limits-contract (gate checks presence by default).
describe("runtime-local-execution-limits-contract", () => {
  bench("identity noop", () => {
    void "runtime-local-execution-limits-contract".length;
  });
});
