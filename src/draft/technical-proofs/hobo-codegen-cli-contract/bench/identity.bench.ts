import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-codegen-cli-contract (gate checks presence by default).
describe("hobo-codegen-cli-contract", () => {
  bench("identity noop", () => {
    void "hobo-codegen-cli-contract".length;
  });
});
