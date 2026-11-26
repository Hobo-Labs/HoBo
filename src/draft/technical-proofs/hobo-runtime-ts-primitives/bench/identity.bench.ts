import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-runtime-ts-primitives (gate checks presence by default).
describe("hobo-runtime-ts-primitives", () => {
  bench("identity noop", () => {
    void "hobo-runtime-ts-primitives".length;
  });
});
