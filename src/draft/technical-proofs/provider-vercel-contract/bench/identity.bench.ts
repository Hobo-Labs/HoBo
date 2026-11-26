import { bench, describe } from "vitest";

// Presence + executable hot-path noop for provider-vercel-contract (gate checks presence by default).
describe("provider-vercel-contract", () => {
  bench("identity noop", () => {
    void "provider-vercel-contract".length;
  });
});
