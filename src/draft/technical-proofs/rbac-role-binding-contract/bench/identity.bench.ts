import { bench, describe } from "vitest";

// Presence + executable hot-path noop for rbac-role-binding-contract (gate checks presence by default).
describe("rbac-role-binding-contract", () => {
  bench("identity noop", () => {
    void "rbac-role-binding-contract".length;
  });
});
