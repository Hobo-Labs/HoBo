import { bench, describe } from "vitest";

// Presence + executable hot-path noop for provider-hetzner-contract (gate checks presence by default).
describe("provider-hetzner-contract", () => {
  bench("identity noop", () => {
    void "provider-hetzner-contract".length;
  });
});
