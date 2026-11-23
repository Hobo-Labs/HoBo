import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { Then, When } from "@cucumber/cucumber";
import { z } from "zod";
import { repoRoot, runInventory } from "./implementations.ts";
import type { InventoryWorld } from "./world.ts";

const outputSchema = z.object({
  proofs: z.array(z.object({
    type: z.literal("ux"),
    audience: z.literal("End users"),
    slug: z.string().min(1),
    path: z.string(),
  })).min(1),
});

When("I run the experience inventory for user proofs as JSON", function (this: InventoryWorld) {
  this.result = runInventory("--type", "ux", "--json");
});

When("I run the experience inventory for an unknown type", function (this: InventoryWorld) {
  this.result = runInventory("--type", "unknown");
});

Then("the inventory lists real user experience packages", function (this: InventoryWorld) {
  assert.ok(this.result);
  assert.equal(this.result.status, 0, this.result.stderr);
  const output = outputSchema.parse(JSON.parse(this.result.stdout));
  for (const proof of output.proofs) {
    assert.equal(proof.path, `src/draft/exp-proofs/ux/${proof.slug}`);
    assert.ok(existsSync(path.join(repoRoot, proof.path, "package.json")));
  }
});

Then("the inventory reports the valid experience types", function (this: InventoryWorld) {
  assert.ok(this.result);
  assert.equal(this.result.status, 2);
  assert.match(this.result.stderr, /choose dx, ux, cx, ax, api/u);
});
