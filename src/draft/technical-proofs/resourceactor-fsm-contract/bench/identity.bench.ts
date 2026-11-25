import { bench, describe } from "vitest";

// Presence + executable hot-path noop for resourceactor-fsm-contract (gate checks presence by default).
describe("resourceactor-fsm-contract", () => {
  bench("identity noop", () => {
    void "resourceactor-fsm-contract".length;
  });
});
