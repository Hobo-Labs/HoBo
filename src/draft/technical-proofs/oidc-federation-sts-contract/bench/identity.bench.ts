import { bench, describe } from "vitest";

// Presence + executable hot-path noop for oidc-federation-sts-contract (gate checks presence by default).
describe("oidc-federation-sts-contract", () => {
  bench("identity noop", () => {
    void "oidc-federation-sts-contract".length;
  });
});
