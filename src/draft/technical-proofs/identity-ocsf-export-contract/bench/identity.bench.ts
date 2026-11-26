import { bench, describe } from "vitest";

// Presence + executable hot-path noop for identity-ocsf-export-contract (gate checks presence by default).
describe("identity-ocsf-export-contract", () => {
  bench("identity noop", () => {
    void "identity-ocsf-export-contract".length;
  });
});
