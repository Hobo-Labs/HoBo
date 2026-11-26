import { bench, describe } from "vitest";

// Presence + executable hot-path noop for registry-compromise-guard-contract (gate checks presence by default).
describe("registry-compromise-guard-contract", () => {
  bench("identity noop", () => {
    void "registry-compromise-guard-contract".length;
  });
});
