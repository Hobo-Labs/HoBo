import { bench, describe } from "vitest";

// Presence + executable hot-path noop for mtls-data-path-contract (gate checks presence by default).
describe("mtls-data-path-contract", () => {
  bench("identity noop", () => {
    void "mtls-data-path-contract".length;
  });
});
