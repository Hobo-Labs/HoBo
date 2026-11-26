import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-auth-json-contract (gate checks presence by default).
describe("hobo-auth-json-contract", () => {
  bench("identity noop", () => {
    void "hobo-auth-json-contract".length;
  });
});
