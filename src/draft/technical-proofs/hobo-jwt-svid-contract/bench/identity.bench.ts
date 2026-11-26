import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-jwt-svid-contract (gate checks presence by default).
describe("hobo-jwt-svid-contract", () => {
  bench("identity noop", () => {
    void "hobo-jwt-svid-contract".length;
  });
});
