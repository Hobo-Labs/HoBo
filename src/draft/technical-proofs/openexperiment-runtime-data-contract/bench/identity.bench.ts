import { bench, describe } from "vitest";

// Presence + executable hot-path noop for openexperiment-runtime-data-contract (gate checks presence by default).
describe("openexperiment-runtime-data-contract", () => {
  bench("identity noop", () => {
    void "openexperiment-runtime-data-contract".length;
  });
});
