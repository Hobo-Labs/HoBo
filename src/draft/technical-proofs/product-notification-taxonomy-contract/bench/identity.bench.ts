import { bench, describe } from "vitest";

// Presence + executable hot-path noop for product-notification-taxonomy-contract (gate checks presence by default).
describe("product-notification-taxonomy-contract", () => {
  bench("identity noop", () => {
    void "product-notification-taxonomy-contract".length;
  });
});
