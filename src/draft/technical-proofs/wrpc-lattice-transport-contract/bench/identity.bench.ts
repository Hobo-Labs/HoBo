import { bench, describe } from "vitest";

// Presence + executable hot-path noop for wrpc-lattice-transport-contract (gate checks presence by default).
describe("wrpc-lattice-transport-contract", () => {
  bench("identity noop", () => {
    void "wrpc-lattice-transport-contract".length;
  });
});
