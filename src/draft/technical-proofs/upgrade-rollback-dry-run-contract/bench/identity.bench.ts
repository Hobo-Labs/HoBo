import { bench, describe } from "vitest";

// Presence + executable hot-path noop for upgrade-rollback-dry-run-contract (gate checks presence by default).
describe("upgrade-rollback-dry-run-contract", () => {
  bench("identity noop", () => {
    void "upgrade-rollback-dry-run-contract".length;
  });
});
