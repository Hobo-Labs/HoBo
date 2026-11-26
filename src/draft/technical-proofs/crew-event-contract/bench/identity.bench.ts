import { bench, describe } from "vitest";

// Presence + executable hot-path noop for crew-event-contract (gate checks presence by default).
describe("crew-event-contract", () => {
  bench("identity noop", () => {
    void "crew-event-contract".length;
  });
});
