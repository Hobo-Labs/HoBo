import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-cli-shell-contract (gate checks presence by default).
describe("hobo-cli-shell-contract", () => {
  bench("identity noop", () => {
    void "hobo-cli-shell-contract".length;
  });
});
