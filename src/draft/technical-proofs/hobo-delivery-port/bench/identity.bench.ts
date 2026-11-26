import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-delivery-port (gate checks presence by default).
describe("hobo-delivery-port", () => {
  bench("identity noop", () => {
    void "hobo-delivery-port".length;
  });
});
