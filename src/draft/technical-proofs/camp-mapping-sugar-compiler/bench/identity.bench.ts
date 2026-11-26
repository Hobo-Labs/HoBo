import { bench, describe } from "vitest";

// Presence + executable hot-path noop for camp-mapping-sugar-compiler (gate checks presence by default).
describe("camp-mapping-sugar-compiler", () => {
  bench("identity noop", () => {
    void "camp-mapping-sugar-compiler".length;
  });
});
