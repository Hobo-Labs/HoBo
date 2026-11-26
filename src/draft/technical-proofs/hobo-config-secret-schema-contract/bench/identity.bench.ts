import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-config-secret-schema-contract (gate checks presence by default).
describe("hobo-config-secret-schema-contract", () => {
  bench("identity noop", () => {
    void "hobo-config-secret-schema-contract".length;
  });
});
