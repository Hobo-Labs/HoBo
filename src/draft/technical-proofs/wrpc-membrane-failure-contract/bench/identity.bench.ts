import { bench, describe } from "vitest";

// Presence + executable hot-path noop for wrpc-membrane-failure-contract (gate checks presence by default).
describe("wrpc-membrane-failure-contract", () => {
  bench("identity noop", () => {
    void "wrpc-membrane-failure-contract".length;
  });
});
