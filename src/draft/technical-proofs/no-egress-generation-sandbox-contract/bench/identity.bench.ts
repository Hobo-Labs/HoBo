import { bench, describe } from "vitest";

// Presence + executable hot-path noop for no-egress-generation-sandbox-contract (gate checks presence by default).
describe("no-egress-generation-sandbox-contract", () => {
  bench("identity noop", () => {
    void "no-egress-generation-sandbox-contract".length;
  });
});
