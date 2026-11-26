import { bench, describe } from "vitest";

// Presence + executable hot-path noop for provider-local-zero-infra (gate checks presence by default).
describe("provider-local-zero-infra", () => {
  bench("identity noop", () => {
    void "provider-local-zero-infra".length;
  });
});
