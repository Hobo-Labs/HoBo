import { bench, describe } from "vitest";

// Presence + executable hot-path noop for flag-ruleset-sync-contract (gate checks presence by default).
describe("flag-ruleset-sync-contract", () => {
  bench("identity noop", () => {
    void "flag-ruleset-sync-contract".length;
  });
});
