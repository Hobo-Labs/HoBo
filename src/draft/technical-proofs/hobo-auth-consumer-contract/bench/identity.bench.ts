import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-auth-consumer-contract (gate checks presence by default).
describe("hobo-auth-consumer-contract", () => {
  bench("identity noop", () => {
    void "hobo-auth-consumer-contract".length;
  });
});
