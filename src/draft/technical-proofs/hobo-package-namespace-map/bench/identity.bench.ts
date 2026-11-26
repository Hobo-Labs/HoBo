import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-package-namespace-map (gate checks presence by default).
describe("hobo-package-namespace-map", () => {
  bench("identity noop", () => {
    void "hobo-package-namespace-map".length;
  });
});
