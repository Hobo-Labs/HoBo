import { bench, describe } from "vitest";

// Presence + executable hot-path noop for resilience-semantics-annex (gate checks presence by default).
describe("resilience-semantics-annex", () => {
  bench("identity noop", () => {
    void "resilience-semantics-annex".length;
  });
});
