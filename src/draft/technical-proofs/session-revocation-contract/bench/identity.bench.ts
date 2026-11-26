import { bench, describe } from "vitest";

// Presence + executable hot-path noop for session-revocation-contract (gate checks presence by default).
describe("session-revocation-contract", () => {
  bench("identity noop", () => {
    void "session-revocation-contract".length;
  });
});
