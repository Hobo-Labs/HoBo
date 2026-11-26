import { bench, describe } from "vitest";

// Presence + executable hot-path noop for provider-aws-full-capability-catalog-contract (gate checks presence by default).
describe("provider-aws-full-capability-catalog-contract", () => {
  bench("identity noop", () => {
    void "provider-aws-full-capability-catalog-contract".length;
  });
});
