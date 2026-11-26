import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parsePersonaModels, listPersonaMetas } from "../lib/persona-resolve.mts";

const body = (thresholds = "featureSprawl: 1\nvisualClutter: 2\ninteractiveClutter: 3\nchoiceOverload: 2\ninformationDensity: 2\nnoveltyTax: 2\ncontextSwitchTax: 2\nworkingMemoryLoad: 2\ninterruptionFragility: 3") => `
## Demographic model
- roleFamily: design
- seniority: junior
- orgArchetype: enterprise
- domainFamiliarity: new-to-hobo
- localeContext: en-primary
- deviceContext: desktop-first
- timeBudget: hours
- accessibilityProfile: cognitive-load-sensitive
## Psychographic model
- values: [clarity, craft]
- riskTolerance: low
- noveltySeeking: low
- trustInAutomation: medium
- documentationPreference: examples-first
- errorEmotion: debug-eager
- socialProofNeed: low
- aestheticSensitivity: high
- controlNeed: medium
## Cognitive thresholds
${thresholds.split("\n").map((x) => `- ${x}`).join("\n")}
`;

describe("persona schema v2", () => {
  it("parses grounded structured models", () => {
    const result = parsePersonaModels(body());
    assert.equal(result.problems.length, 0);
    assert.equal(result.models?.roleFamily, "design");
    assert.equal(result.models?.thresholds.featureSprawl, 1);
  });

  it("rejects unconstrained all-five thresholds", () => {
    const allFive = ["featureSprawl", "visualClutter", "interactiveClutter", "choiceOverload", "informationDensity", "noveltyTax", "contextSwitchTax", "workingMemoryLoad", "interruptionFragility"].map((k) => `${k}: 5`).join("\n");
    assert.ok(parsePersonaModels(body(allFive)).problems.some((p) => p.includes("cannot all be 5")));
  });

  it("does not select malformed v2 personas", () => {
    const root = mkdtempSync(path.join(tmpdir(), "oxp-persona-"));
    const dir = path.join(root, ".optimizexp", "personas");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "bad.md"), `---\nid: bad\nschemaVersion: 2\nexperiences: [dx]\n---\n${body()}`.replace("- featureSprawl: 1", "- featureSprawl: nope"));
    const meta = listPersonaMetas(root).find((m) => m.id === "bad");
    assert.ok(meta);
    assert.ok(meta?.experienceProblems.length);
  });
});
