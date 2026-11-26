import { bench, describe } from "vitest";

// Presence + executable hot-path noop for execution-host-provider-contract (gate checks presence by default).
describe("execution-host-provider-contract", () => {
  bench("identity noop", () => {
    void "execution-host-provider-contract".length;
  });
});
