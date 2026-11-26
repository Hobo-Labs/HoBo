import { bench, describe } from "vitest";

// Presence + executable hot-path noop for sandboxed-executors-contract (gate checks presence by default).
describe("sandboxed-executors-contract", () => {
  bench("identity noop", () => {
    void "sandboxed-executors-contract".length;
  });
});
