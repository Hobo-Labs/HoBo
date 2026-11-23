import assert from "node:assert/strict";
import { Then, When } from "@cucumber/cucumber";
import { visitPublicSite } from "./implementations.ts";
import type { PublicSiteWorld } from "./world.ts";

function visit(world: PublicSiteWorld) {
  assert.ok(world.visit, "open the public site first");
  return world.visit;
}

When("I open the public site", { timeout: 60_000 }, async function (this: PublicSiteWorld) {
  this.visit = await visitPublicSite();
});

Then("the public site title contains {string}", function (this: PublicSiteWorld, text: string) {
  assert.ok(visit(this).title.includes(text));
});

Then("the public site introduction contains {string}", function (this: PublicSiteWorld, text: string) {
  assert.ok(visit(this).description.includes(text));
});

Then("the public site next action is {string}", function (this: PublicSiteWorld, text: string) {
  assert.equal(visit(this).nextAction, text);
});

Then("the next action opens the getting-started guide", function (this: PublicSiteWorld) {
  assert.equal(visit(this).guidePath, "/HoBo/guide/getting-started/");
  assert.match(visit(this).guideHeading, /Getting started/u);
});
