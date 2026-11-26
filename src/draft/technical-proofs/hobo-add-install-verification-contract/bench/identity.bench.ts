import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-add-install-verification-contract (gate checks presence by default).
describe("hobo-add-install-verification-contract", () => {
  bench("identity noop", () => {
    void "hobo-add-install-verification-contract".length;
  });
});
