import { readFileSync } from "node:fs";
import { conciseGeneratedTypeScript } from "@hobo/schema-tools/generated-typescript";
import { bench, describe } from "vitest";

const source = readFileSync(
  new URL("../packages/core/src/_generated/hobo/core/v1/event_envelope_pb.ts", import.meta.url),
  "utf8",
);
if (conciseGeneratedTypeScript(source) !== source) {
  throw new Error("generated TypeScript is not normalized");
}

describe("generated TypeScript", () => {
  bench("normalize the event envelope module", () => {
    conciseGeneratedTypeScript(source);
  });
});
