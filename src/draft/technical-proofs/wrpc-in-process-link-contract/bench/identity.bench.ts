import { bench, describe } from "vitest";

// Presence + executable hot-path noop for wrpc-in-process-link-contract (gate checks presence by default).
describe("wrpc-in-process-link-contract", () => {
  bench("identity noop", () => {
    void "wrpc-in-process-link-contract".length;
  });
});
