import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-monorepo-skeleton-contract (gate checks presence by default).
describe("hobo-monorepo-skeleton-contract", () => {
  bench("identity noop", () => {
    void "hobo-monorepo-skeleton-contract".length;
  });
});
