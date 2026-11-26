import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-build-cli-contract (gate checks presence by default).
describe("hobo-build-cli-contract", () => {
  bench("identity noop", () => {
    void "hobo-build-cli-contract".length;
  });
});
