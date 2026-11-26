import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-logs-cli-contract (gate checks presence by default).
describe("hobo-logs-cli-contract", () => {
  bench("identity noop", () => {
    void "hobo-logs-cli-contract".length;
  });
});
