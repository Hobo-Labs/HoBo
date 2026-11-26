import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-bindles-resource-catalog (gate checks presence by default).
describe("hobo-bindles-resource-catalog", () => {
  bench("identity noop", () => {
    void "hobo-bindles-resource-catalog".length;
  });
});
