import assert from "node:assert/strict";
import { Then, When } from "@cucumber/cucumber";
import { inspectPalette } from "./implementations.ts";
import type { PaletteWorld } from "./world.ts";

function issues(world: PaletteWorld): string[] {
  assert.ok(world.issues, "run palette validation first");
  return world.issues;
}

When("I run palette validation on the current source", function (this: PaletteWorld) {
  this.issues = inspectPalette(false);
});

When("I run palette validation with unreadable text", function (this: PaletteWorld) {
  this.issues = inspectPalette(true);
});

Then("palette validation reports no issues", function (this: PaletteWorld) {
  assert.deepEqual(issues(this), []);
});

Then("palette validation reports {string}", function (this: PaletteWorld, expected: string) {
  assert.ok(issues(this).join("\n").includes(expected));
});
