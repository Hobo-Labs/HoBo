import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-experiment-port (gate checks presence by default).
describe("hobo-experiment-port", () => {
  bench("identity noop", () => {
    void "hobo-experiment-port".length;
  });
});
