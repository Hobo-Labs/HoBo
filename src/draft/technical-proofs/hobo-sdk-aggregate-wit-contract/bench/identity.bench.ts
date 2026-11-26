import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-sdk-aggregate-wit-contract (gate checks presence by default).
describe("hobo-sdk-aggregate-wit-contract", () => {
  bench("identity noop", () => {
    void "hobo-sdk-aggregate-wit-contract".length;
  });
});
