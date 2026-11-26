import { expect, it } from "vitest";
import { visitPublicSite } from "../steps/implementations.ts";

it("explains HoBo and opens the getting-started guide", { timeout: 60_000 }, async () => {
  const visit = await visitPublicSite();
  expect(visit.title).toContain("HoBo");
  expect(visit.heading).toContain("find your app a home");
  expect(visit.description).toContain("cheapest infrastructure");
  expect(visit.description).toContain("your policies");
  expect(visit.nextAction).toBe("Get started");
  expect(visit.guidePath).toBe("/HoBo/guide/getting-started/");
  expect(visit.guideHeading).toContain("Getting started");
});
