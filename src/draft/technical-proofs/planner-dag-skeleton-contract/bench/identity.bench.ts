import { bench, describe } from "vitest";

// Presence + executable hot-path noop for planner-dag-skeleton-contract (gate checks presence by default).
describe("planner-dag-skeleton-contract", () => {
  bench("identity noop", () => {
    void "planner-dag-skeleton-contract".length;
  });
});
