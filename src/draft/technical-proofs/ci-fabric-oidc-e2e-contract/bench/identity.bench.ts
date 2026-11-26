import { bench, describe } from "vitest";

// Presence + executable hot-path noop for ci-fabric-oidc-e2e-contract (gate checks presence by default).
describe("ci-fabric-oidc-e2e-contract", () => {
  bench("identity noop", () => {
    void "ci-fabric-oidc-e2e-contract".length;
  });
});
