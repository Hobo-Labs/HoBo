import { bench, describe } from "vitest";

// Presence + executable hot-path noop for wasi-interface-pins (gate checks presence by default).
describe("wasi-interface-pins", () => {
  bench("identity noop", () => {
    void "wasi-interface-pins".length;
  });
});
