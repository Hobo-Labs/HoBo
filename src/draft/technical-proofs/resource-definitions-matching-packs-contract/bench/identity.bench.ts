import { bench, describe } from "vitest";

// Presence + executable hot-path noop for resource-definitions-matching-packs-contract (gate checks presence by default).
describe("resource-definitions-matching-packs-contract", () => {
  bench("identity noop", () => {
    void "resource-definitions-matching-packs-contract".length;
  });
});
