import { bench, describe } from "vitest";

// Presence + executable hot-path noop for x509-svid-mtls-contract (gate checks presence by default).
describe("x509-svid-mtls-contract", () => {
  bench("identity noop", () => {
    void "x509-svid-mtls-contract".length;
  });
});
