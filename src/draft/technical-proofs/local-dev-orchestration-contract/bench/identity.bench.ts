import { bench, describe } from "vitest";

// Presence + executable hot-path noop for local-dev-orchestration-contract (gate checks presence by default).
describe("local-dev-orchestration-contract", () => {
  bench("identity noop", () => {
    void "local-dev-orchestration-contract".length;
  });
});
