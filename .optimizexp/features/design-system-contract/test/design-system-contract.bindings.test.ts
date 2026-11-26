import { describe, expect, it } from "vitest";
import { inspectPalette } from "../steps/implementations.ts";

describe("visual token contrast", () => {
  it("accepts the implemented site and connection palettes", () => {
    expect(inspectPalette(false)).toEqual([]);
  });

  it("reports the source file and minimum when text is unreadable", () => {
    const output = inspectPalette(true).join("\n");
    expect(output).toContain("site/src/styles/global.css");
    expect(output).toContain("contrast");
    expect(output).toContain("minimum is 4.5");
  });
});
