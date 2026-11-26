import { bench, describe } from "vitest";

// Presence + executable hot-path noop for provider-kubernetes-contract (gate checks presence by default).
describe("provider-kubernetes-contract", () => {
  bench("identity noop", () => {
    void "provider-kubernetes-contract".length;
  });
});
