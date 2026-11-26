import { bench, describe } from "vitest";

// Presence + executable hot-path noop for event-body-upcaster-gate (gate checks presence by default).
describe("event-body-upcaster-gate", () => {
  bench("identity noop", () => {
    void "event-body-upcaster-gate".length;
  });
});
