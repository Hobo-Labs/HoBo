import { describe, expect, it } from "vitest";
import { visitorCountFromProvider } from "../src/analytics/visitorCount";

describe("visitorCountFromProvider", () => {
  it("accepts nonnegative safe integers and decimal strings", () => {
    expect(visitorCountFromProvider(0)).toBe(0);
    expect(visitorCountFromProvider(42)).toBe(42);
    expect(visitorCountFromProvider("17")).toBe(17);
    expect(visitorCountFromProvider("  9  ")).toBe(9);
  });

  it("rejects coerced invalid shapes", () => {
    for (const value of [null, undefined, "", "  ", true, false, [], {}, 3.5, -1, "12.3", "1e3"]) {
      expect(() => visitorCountFromProvider(value)).toThrow("Invalid visitor count");
    }
  });
});