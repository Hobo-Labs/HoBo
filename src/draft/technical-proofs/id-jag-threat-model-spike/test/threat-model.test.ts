import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";
import {
  REQUIRED_DRAFT_VERSION,
  REQUIRED_THREAT_IDS,
  findThreat,
  validateThreatModel
} from "../src/threat-model.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "..", "fixtures", "threat-model.json");

const loadFixture = async () => JSON.parse(await readFile(fixturePath, "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));

test("threat model covers the required HOBO-271 threat families", async () => {
  const model = await loadFixture();

  assert.deepEqual(
    model.threats.map((threat) => threat.id).sort(),
    [...REQUIRED_THREAT_IDS].sort()
  );
  assert.equal(validateThreatModel(model).ok, true);
});

test("adversarial vectors carry an explicit priority order", async () => {
  const model = await loadFixture();

  assert.deepEqual(
    model.threats.map((threat) => threat.priority).sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7, 8, 9]
  );

  const duplicate = clone(model);
  findThreat(duplicate, "refresh-token-subject-broadening").priority = 1;
  const result = validateThreatModel(duplicate);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /priorities/);
});

test("draft strategy is pinned and requires revalidation before a bump", async () => {
  const model = await loadFixture();

  assert.equal(model.draft.pinnedVersion, REQUIRED_DRAFT_VERSION);
  assert.match(model.draft.datatrackerUrl, /datatracker\.ietf\.org/);
  assert.ok(model.draft.reviewTriggers.some((trigger) => /newer draft revision/i.test(trigger)));

  const bumped = clone(model);
  bumped.draft.pinnedVersion = "draft-ietf-oauth-identity-assertion-authz-grant-05";
  const result = validateThreatModel(bumped);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /draft pin/);
});

test("forced fallback from XAA to OBO is policy-gated and audited", async () => {
  const model = await loadFixture();
  const fallback = findThreat(model, "fallback-downgrade-to-obo");

  assert.deepEqual(
    ["capability-discovery", "mandatory-xaa-policy", "fallback-explicitness", "credential-audit"].every(
      (control) => fallback.controls.includes(control)
    ),
    true
  );
  assert.equal(fallback.failClosed, true);

  const weakened = clone(model);
  findThreat(weakened, "fallback-downgrade-to-obo").controls =
    fallback.controls.filter((control) => control !== "mandatory-xaa-policy");
  const result = validateThreatModel(weakened);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /mandatory-xaa-policy/);
});

test("actor-token and proof-of-possession downgrades fail closed", async () => {
  const model = await loadFixture();
  const actorToken = findThreat(model, "actor-token-confusion");
  const proofOfPossession = findThreat(model, "pop-dpop-downgrade");

  assert.equal(actorToken.failClosed, true);
  assert.ok(actorToken.controls.includes("unsupported-actor-token-reject"));
  assert.equal(proofOfPossession.failClosed, true);
  assert.ok(proofOfPossession.controls.includes("downgrade-reject"));

  const bearerDowngrade = clone(model);
  findThreat(bearerDowngrade, "pop-dpop-downgrade").failClosed = false;
  const result = validateThreatModel(bearerDowngrade);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /pop-dpop-downgrade must fail closed/);
});

test("each threat maps to adversarial or contract handoff work", async () => {
  const model = await loadFixture();

  for (const threat of model.threats) {
    assert.ok(threat.handoff.length > 0, `${threat.id} missing handoff`);
    assert.ok(
      threat.handoff.some((issue) => ["HOBO-250", "HOBO-255", "HOBO-54"].includes(issue)),
      `${threat.id} must reach an adversarial or wire-contract handoff`
    );
  }
});
