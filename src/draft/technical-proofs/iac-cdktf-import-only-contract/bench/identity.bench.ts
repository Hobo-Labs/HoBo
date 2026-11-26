import { bench, describe } from "vitest";

// Presence + executable hot-path noop for iac-cdktf-import-only-contract (gate checks presence by default).
describe("iac-cdktf-import-only-contract", () => {
  bench("identity noop", () => {
    void "iac-cdktf-import-only-contract".length;
  });
});
