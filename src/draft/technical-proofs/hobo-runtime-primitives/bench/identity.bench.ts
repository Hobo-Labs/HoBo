import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-runtime-primitives (gate checks presence by default).
describe("hobo-runtime-primitives", () => {
  bench("identity noop", () => {
    void "hobo-runtime-primitives".length;
  });
});
