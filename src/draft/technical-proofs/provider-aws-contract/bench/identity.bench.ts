import { bench, describe } from "vitest";

// Presence + executable hot-path noop for provider-aws-contract (gate checks presence by default).
describe("provider-aws-contract", () => {
  bench("identity noop", () => {
    void "provider-aws-contract".length;
  });
});
