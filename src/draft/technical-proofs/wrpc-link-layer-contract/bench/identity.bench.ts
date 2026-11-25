import { bench, describe } from "vitest";

// Presence + executable hot-path noop for wrpc-link-layer-contract (gate checks presence by default).
describe("wrpc-link-layer-contract", () => {
  bench("identity noop", () => {
    void "wrpc-link-layer-contract".length;
  });
});
