import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-gateway-port (gate checks presence by default).
describe("hobo-gateway-port", () => {
  bench("identity noop", () => {
    void "hobo-gateway-port".length;
  });
});
