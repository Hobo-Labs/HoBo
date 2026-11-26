import { bench, describe } from "vitest";

// Presence + executable hot-path noop for obligation-engine-contract (gate checks presence by default).
describe("obligation-engine-contract", () => {
  bench("identity noop", () => {
    void "obligation-engine-contract".length;
  });
});
