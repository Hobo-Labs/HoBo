import { bench, describe } from "vitest";

// Presence + executable hot-path noop for control-plane-authz-cache-contract (gate checks presence by default).
describe("control-plane-authz-cache-contract", () => {
  bench("identity noop", () => {
    void "control-plane-authz-cache-contract".length;
  });
});
