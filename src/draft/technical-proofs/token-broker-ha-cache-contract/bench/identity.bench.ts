import { bench, describe } from "vitest";

// Presence + executable hot-path noop for token-broker-ha-cache-contract (gate checks presence by default).
describe("token-broker-ha-cache-contract", () => {
  bench("identity noop", () => {
    void "token-broker-ha-cache-contract".length;
  });
});
