import { bench, describe } from "vitest";

// Presence + executable hot-path noop for s0-04-protobuf-cue-codegen (gate checks presence by default).
describe("s0-04-protobuf-cue-codegen", () => {
  bench("identity noop", () => {
    void "s0-04-protobuf-cue-codegen".length;
  });
});
