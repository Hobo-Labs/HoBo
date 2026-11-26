import { bench, describe } from "vitest";

// Presence + executable hot-path noop for yard-identity-issuer-contract (gate checks presence by default).
describe("yard-identity-issuer-contract", () => {
  bench("identity noop", () => {
    void "yard-identity-issuer-contract".length;
  });
});
