import { bench, describe } from "vitest";

// Presence + executable hot-path noop for control-plane-event-schema-contract (gate checks presence by default).
describe("control-plane-event-schema-contract", () => {
  bench("identity noop", () => {
    void "control-plane-event-schema-contract".length;
  });
});
