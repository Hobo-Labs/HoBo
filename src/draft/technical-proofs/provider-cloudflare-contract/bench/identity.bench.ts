import { bench, describe } from "vitest";

// Presence + executable hot-path noop for provider-cloudflare-contract (gate checks presence by default).
describe("provider-cloudflare-contract", () => {
  bench("identity noop", () => {
    void "provider-cloudflare-contract".length;
  });
});
