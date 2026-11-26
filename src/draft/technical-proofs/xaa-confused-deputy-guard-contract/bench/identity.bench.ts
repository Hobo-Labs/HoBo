import { bench, describe } from "vitest";

// Presence + executable hot-path noop for xaa-confused-deputy-guard-contract (gate checks presence by default).
describe("xaa-confused-deputy-guard-contract", () => {
  bench("identity noop", () => {
    void "xaa-confused-deputy-guard-contract".length;
  });
});
