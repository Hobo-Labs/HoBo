/**
 * Vitest binding/smoke tests for OptimizeXP feature `cli-product`.
 * Does not require Cucumber CLI; imports implementations directly.
 */
import { describe, expect, it } from "vitest";
import {
  DISCOVERY_PRIMARY,
  IMPLEMENTATION_STATUS,
  assertExitCode,
  assertJsonFieldEquals,
  runHoboCli,
  setFeatureContext,
  setPersona,
} from "../steps/implementations.ts";
import { createWorld } from "../steps/world.ts";

describe("optimizexp feature cli-product bindings", () => {
  it("exposes discovery metadata", () => {
    expect(DISCOVERY_PRIMARY.command).toBe("hobo --help");
    expect(IMPLEMENTATION_STATUS.exerciseSurface).toBe("wired");
  });

  it("sets persona and feature context", () => {
    const world = createWorld("cli-product");
    setPersona(world, "product-app-developer");
    setFeatureContext(world, "cli-product");
    expect(world.personaId).toBe("product-app-developer");
    expect(world.featureId).toBe("cli-product");
  });

  it("runs hobo --help and asserts exit code", () => {
    const world = createWorld("cli-product");
    runHoboCli(world, "--help");
    assertExitCode(world, 0);
    expect(world.lastStdout).toContain("Canonical verbs:");
  });

  it("runs hobo stub verb and parses the JSON envelope", () => {
    const world = createWorld("cli-product");
    runHoboCli(world, "deploy --json");
    assertExitCode(world, 1);
    assertJsonFieldEquals(world, "status", "not_implemented");
    assertJsonFieldEquals(world, "code", "HOBO_CLI_STUB");
  });
});
