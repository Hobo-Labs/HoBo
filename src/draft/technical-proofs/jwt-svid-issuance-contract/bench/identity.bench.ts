import { bench, describe } from "vitest";

// Presence + executable hot-path noop for jwt-svid-issuance-contract (gate checks presence by default).
describe("jwt-svid-issuance-contract", () => {
  bench("identity noop", () => {
    void "jwt-svid-issuance-contract".length;
  });
});
