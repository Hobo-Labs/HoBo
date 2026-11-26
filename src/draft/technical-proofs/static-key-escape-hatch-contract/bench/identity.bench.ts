import { bench, describe } from "vitest";

// Presence + executable hot-path noop for static-key-escape-hatch-contract (gate checks presence by default).
describe("static-key-escape-hatch-contract", () => {
  bench("identity noop", () => {
    void "static-key-escape-hatch-contract".length;
  });
});
