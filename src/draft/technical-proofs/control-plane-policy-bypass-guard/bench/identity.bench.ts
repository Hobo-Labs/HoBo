import { bench, describe } from "vitest";

// Presence + executable hot-path noop for control-plane-policy-bypass-guard (gate checks presence by default).
describe("control-plane-policy-bypass-guard", () => {
  bench("identity noop", () => {
    void "control-plane-policy-bypass-guard".length;
  });
});
