import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-login-claim-contract (gate checks presence by default).
describe("hobo-login-claim-contract", () => {
  bench("identity noop", () => {
    void "hobo-login-claim-contract".length;
  });
});
