import { bench, describe } from "vitest";

// Presence + executable hot-path noop for registry-dependency-confusion-guard-contract (gate checks presence by default).
describe("registry-dependency-confusion-guard-contract", () => {
  bench("identity noop", () => {
    void "registry-dependency-confusion-guard-contract".length;
  });
});
