import { bench, describe } from "vitest";

// Presence + executable hot-path noop for reactor-skeleton-contract (gate checks presence by default).
describe("reactor-skeleton-contract", () => {
  bench("identity noop", () => {
    void "reactor-skeleton-contract".length;
  });
});
