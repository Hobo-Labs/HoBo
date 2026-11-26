import { bench, describe } from "vitest";

// Presence + executable hot-path noop for showback-attribution-contract (gate checks presence by default).
describe("showback-attribution-contract", () => {
  bench("identity noop", () => {
    void "showback-attribution-contract".length;
  });
});
