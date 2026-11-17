/**
 * Cucumber step bindings for OptimizeXP feature `cli-product`.
 * Thin adapters → implementations.ts (keeps Gherkin text stable).
 *
 * These bindings are shared: `cli-help-and-doctor` re-uses them via a
 * side-effect import so both folders exercise the same real-CLI steps
 * without duplicate step definitions.
 */
import { Given, Then, When } from "@cucumber/cucumber";
import {
  assertExitCode,
  assertJsonEnvelopeShape,
  assertJsonFieldEquals,
  assertJsonFieldNonEmptyArray,
  assertStdoutContains,
  assertStdoutMatches,
  markEvidenceCapturable,
  runHoboCli,
  runHoboComposedCli,
  setFeatureContext,
  setPersona,
} from "./implementations.ts";
import { createWorld, type OptimizexpWorld } from "./world.ts";

function w(world: OptimizexpWorld | undefined): OptimizexpWorld {
  // Cucumber passes its own World instance as `this`; use ours (singleton)
  // unless the caller already carries our shape.
  return world && Array.isArray(world.notes) ? world : getSingleton();
}

let singleton: OptimizexpWorld | null = null;
function getSingleton(): OptimizexpWorld {
  singleton ??= createWorld("cli-product");
  return singleton;
}

Given("persona {string} is active", function (this: OptimizexpWorld, personaId: string) {
  const world = this?.featureId ? this : getSingleton();
  if (!world.featureId) Object.assign(world, createWorld("cli-product"));
  setPersona(world, personaId);
});

Given(
  "feature {string} is under optimizexp review",
  function (this: OptimizexpWorld, featureId: string) {
    const world = this?.featureId ? this : getSingleton();
    setFeatureContext(world, featureId);
  },
);

When(
  "I run the hobo CLI with arguments {string}",
  function (this: OptimizexpWorld, args: string) {
    runHoboCli(w(this), args);
  },
);

When(
  "I run the composed hobo CLI with arguments {string}",
  function (this: OptimizexpWorld, args: string) {
    runHoboComposedCli(w(this), args);
  },
);

Then("the exit code is {int}", function (this: OptimizexpWorld, code: number) {
  assertExitCode(w(this), code);
});

Then(
  "stdout contains {string}",
  function (this: OptimizexpWorld, text: string) {
    assertStdoutContains(w(this), text);
  },
);

Then(
  "stdout matches the pattern {string}",
  function (this: OptimizexpWorld, pattern: string) {
    assertStdoutMatches(w(this), pattern);
  },
);

Then(
  "the JSON envelope on stdout has {string} equal to {string}",
  function (this: OptimizexpWorld, field: string, expected: string) {
    assertJsonFieldEquals(w(this), field, expected);
  },
);

Then(
  "the JSON envelope on stdout has a non-empty {string} array",
  function (this: OptimizexpWorld, field: string) {
    assertJsonFieldNonEmptyArray(w(this), field);
  },
);

Then("the stdout is a JSON envelope with the standard shape", function (this: OptimizexpWorld) {
  assertJsonEnvelopeShape(w(this));
});

Then("evidence is capturable for this scenario", function (this: OptimizexpWorld) {
  markEvidenceCapturable(w(this));
});

// re-export for tests
export { createWorld, getSingleton };
