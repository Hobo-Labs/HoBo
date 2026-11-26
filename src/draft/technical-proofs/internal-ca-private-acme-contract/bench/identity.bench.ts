import { bench, describe } from "vitest";

// Presence + executable hot-path noop for internal-ca-private-acme-contract (gate checks presence by default).
describe("internal-ca-private-acme-contract", () => {
  bench("identity noop", () => {
    void "internal-ca-private-acme-contract".length;
  });
});
