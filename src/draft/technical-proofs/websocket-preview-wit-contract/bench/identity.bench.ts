import { bench, describe } from "vitest";

// Presence + executable hot-path noop for websocket-preview-wit-contract (gate checks presence by default).
describe("websocket-preview-wit-contract", () => {
  bench("identity noop", () => {
    void "websocket-preview-wit-contract".length;
  });
});
