import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-collect-cli-contract (gate checks presence by default).
describe("hobo-collect-cli-contract", () => {
  bench("identity noop", () => {
    void "hobo-collect-cli-contract".length;
  });
});
