import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-dns-port-contract (gate checks presence by default).
describe("hobo-dns-port-contract", () => {
  bench("identity noop", () => {
    void "hobo-dns-port-contract".length;
  });
});
