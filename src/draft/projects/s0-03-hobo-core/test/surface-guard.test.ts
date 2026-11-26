import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CORE_API_SNAPSHOT,
  assertCoreApiSnapshot,
  validatePublicTypeSurface,
} from "../src/index.js";

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

describe("public type surface guard", () => {
  it("pins the API snapshot and validates the built declaration file", () => {
    const declaration = readFileSync(join(distDir, "index.d.ts"), "utf8");

    expect(assertCoreApiSnapshot(CORE_API_SNAPSHOT)).toEqual(CORE_API_SNAPSHOT);
    expect(validatePublicTypeSurface(declaration).ok).toBe(true);
  });

  it("detects snapshot drift", () => {
    expect(() =>
      assertCoreApiSnapshot({
        ...CORE_API_SNAPSHOT,
        exports: CORE_API_SNAPSHOT.exports.filter((name) => name !== "ProviderPort"),
      }),
    ).toThrow(/public API snapshot drift/);
  });

  it("detects provider symbol leaks including AwsS3Options", () => {
    const result = validatePublicTypeSurface("export interface AwsS3Options { region: string }");

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/provider-specific symbol leak/i);
  });
});
