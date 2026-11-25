import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import { scanPatternsStandardsLinks } from "../src/link-guard.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

function slugifyHeading(heading: string) {
  return heading
    .replace(/`([^`]+)`/g, "$1")
    .toLowerCase()
    .replace(/&/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s/g, "-");
}

function anchorExists(file: string, anchor: string) {
  const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
  const slug = anchor.slice(1);
  if (content.includes(`{#${slug}}`) || content.includes(`id="${slug}"`)) {
    return true;
  }

  for (const match of content.matchAll(/^##\s+(.+)$/gm)) {
    if (slugifyHeading(match[1]) === slug) {
      return true;
    }
  }

  return false;
}

test("patterns have zero rotted forge-generated-stack or event-model links", () => {
  const { rottedReferences, brokenLinks } = scanPatternsStandardsLinks(repoRoot, ["patterns"]);

  assert.deepEqual(
    rottedReferences,
    [],
    `rotted references remain: ${JSON.stringify(rottedReferences, null, 2)}`,
  );
  assert.deepEqual(brokenLinks, [], `broken links remain: ${JSON.stringify(brokenLinks, null, 2)}`);
});

test("standards cross-links resolve to current design paths", () => {
  const { rottedReferences, brokenLinks } = scanPatternsStandardsLinks(repoRoot, ["standards"]);

  assert.deepEqual(rottedReferences, []);
  assert.deepEqual(brokenLinks, []);
});

test("remapped plan anchors still exist in target design docs", () => {
  assert.equal(anchorExists("docs/design/data-plane.md", "#plan-11"), true);
  assert.equal(anchorExists("docs/design/generated-stack.md", "#plan-09"), true);
  assert.equal(anchorExists("docs/design/generated-stack.md", "#plan-23"), true);
});

test("architecture artifacts pin protobuf, CUE, Pact, and ADR boundaries", () => {
  const adr = fs.readFileSync(new URL("../ADR.md", import.meta.url), "utf8");
  const proto = fs.readFileSync(
    new URL("../architecture/patterns_standards_cross_links.proto", import.meta.url),
    "utf8",
  );
  const cue = fs.readFileSync(
    new URL("../architecture/patterns_standards_cross_links.cue", import.meta.url),
    "utf8",
  );
  const pact = JSON.parse(
    fs.readFileSync(
      new URL("../architecture/pacts/patterns_standards_cross_links.pact.json", import.meta.url),
      "utf8",
    ),
  );

  assert.match(proto, /message PatternsStandardsCrossLinksRecord/);
  assert.match(cue, /#PatternsStandardsCrossLinksRecord:/);
  assert.equal(pact.consumer.name, "PatternsStandardsCrossLinksConsumer");
  assert.equal(pact.provider.name, "PatternsStandardsCrossLinksBoundary");
  assert.equal(pact.interactions[0].response.body.schema, "hobo.draft.patterns_standards_cross_links/v1");
  assert.match(adr, /parse, don't validate/i);
  assert.match(adr, /Command/i);
  assert.match(adr, /Event/i);
  assert.match(adr, /Actor/i);
  assert.match(adr, /event store/i);
  assert.match(adr, /projection/i);
  assert.match(adr, /read store/i);
});
