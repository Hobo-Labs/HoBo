import { bench, describe } from "vitest";

// Presence + executable hot-path noop for provider-gcp-contract (gate checks presence by default).
describe("provider-gcp-contract", () => {
  bench("identity noop", () => {
    void "provider-gcp-contract".length;
  });
});
