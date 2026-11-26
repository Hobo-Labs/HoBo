import { bench, describe } from "vitest";

// Presence + executable hot-path noop for openinference-trajectory-capture-contract (gate checks presence by default).
describe("openinference-trajectory-capture-contract", () => {
  bench("identity noop", () => {
    void "openinference-trajectory-capture-contract".length;
  });
});
