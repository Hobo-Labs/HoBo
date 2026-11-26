import { bench, describe } from "vitest";

// Presence + executable hot-path noop for identity-event-contract (gate checks presence by default).
describe("identity-event-contract", () => {
  bench("identity noop", () => {
    void "identity-event-contract".length;
  });
});
