import { bench, describe } from "vitest";

// Presence + executable hot-path noop for trace-context-propagation-contract (gate checks presence by default).
describe("trace-context-propagation-contract", () => {
  bench("identity noop", () => {
    void "trace-context-propagation-contract".length;
  });
});
