import { Then, When } from "@cucumber/cucumber";
import {
  assertExitCode,
  assertJsonEnvelopeShape,
  assertJsonFieldEquals,
  assertJsonFieldNonEmptyArray,
  assertStdoutContains,
  assertStdoutMatches,
  runHoboCli,
  runHoboComposedCli,
} from "./implementations.ts";
import { createWorld, type OptimizexpWorld } from "./world.ts";

function w(world: OptimizexpWorld | undefined): OptimizexpWorld {
  return world && Array.isArray(world.notes) ? world : getSingleton();
}

let singleton: OptimizexpWorld | null = null;
function getSingleton(): OptimizexpWorld {
  singleton ??= createWorld("cli-product");
  return singleton;
}

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

export { createWorld, getSingleton };
