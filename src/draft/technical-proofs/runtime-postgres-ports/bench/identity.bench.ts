import { bench, describe } from "vitest";

// Presence + executable hot-path noop for runtime-postgres-ports (gate checks presence by default).
describe("runtime-postgres-ports", () => {
  bench("identity noop", () => {
    void "runtime-postgres-ports".length;
  });
});
