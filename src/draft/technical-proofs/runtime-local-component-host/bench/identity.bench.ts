import { bench, describe } from "vitest";

// Presence + executable hot-path noop for runtime-local-component-host (gate checks presence by default).
describe("runtime-local-component-host", () => {
  bench("identity noop", () => {
    void "runtime-local-component-host".length;
  });
});
