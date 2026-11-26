import { bench, describe } from "vitest";

// Presence + executable hot-path noop for vscode-extension-contract (gate checks presence by default).
describe("vscode-extension-contract", () => {
  bench("identity noop", () => {
    void "vscode-extension-contract".length;
  });
});
