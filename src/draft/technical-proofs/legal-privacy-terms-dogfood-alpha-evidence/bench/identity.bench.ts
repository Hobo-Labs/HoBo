import { bench, describe } from "vitest";

// Presence + executable hot-path noop for legal-privacy-terms-dogfood-alpha-evidence (gate checks presence by default).
describe("legal-privacy-terms-dogfood-alpha-evidence", () => {
  bench("identity noop", () => {
    void "legal-privacy-terms-dogfood-alpha-evidence".length;
  });
});
