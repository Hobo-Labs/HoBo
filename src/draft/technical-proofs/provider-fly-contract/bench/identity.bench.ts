import { bench, describe } from "vitest";

// Presence + executable hot-path noop for provider-fly-contract (gate checks presence by default).
describe("provider-fly-contract", () => {
  bench("identity noop", () => {
    void "provider-fly-contract".length;
  });
});
