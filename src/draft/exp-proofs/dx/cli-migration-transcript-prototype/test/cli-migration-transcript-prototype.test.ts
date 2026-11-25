import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

import {
  CLI_MIGRATION_TRANSCRIPT_PROTOTYPE,
  REQUIRED_GATEKEEPER_BLOCKERS,
  REQUIRED_MIGRATION_EVENTS,
  REQUIRED_TRANSCRIPT_CASES,
  assertMigrationExampleParity,
  parseCliMigrationTranscriptPrototype,
  rejectMigrationScopeCreep,
} from "../src/cli-migration-transcript-prototype.ts";
import { type JsonValue } from "../src/json.js";


test("HOBO-575 transcript prototype covers every required migration story beat", () => {
  const prototype = parseCliMigrationTranscriptPrototype(CLI_MIGRATION_TRANSCRIPT_PROTOTYPE);

  assert.equal(prototype.issue, "HOBO-575");
  assert.equal(prototype.phase, "M2");
  assert.equal(
    prototype.targetPackage,
    "src/draft/exp-proofs/dx/cli-migration-transcript-prototype",
  );
  assert.equal(
    prototype.proofNote,
    "docs/design/proofs/cli-migration-transcript-prototype/README.md",
  );
  assert.deepEqual(
    prototype.transcriptSteps.map((step) => step.case),
    [...REQUIRED_TRANSCRIPT_CASES],
  );

  for (const step of prototype.transcriptSteps) {
    assert.ok(step.command.startsWith("hobo "), `${step.case} needs terminal-first command`);
    assert.ok(step.actor.length > 0, `${step.case} needs actor`);
    assert.ok(step.resultEnvelope.code.startsWith("migration."), `${step.case} needs migration envelope`);
  }
});

test("migration fixture events include plan, snapshot, phase, verification, rollback, export, import, and cutover", () => {
  const prototype = parseCliMigrationTranscriptPrototype(CLI_MIGRATION_TRANSCRIPT_PROTOTYPE);

  assert.deepEqual(
    prototype.eventFixtures.map((event) => event.type),
    [...REQUIRED_MIGRATION_EVENTS],
  );

  for (const event of prototype.eventFixtures) {
    assert.equal(event.proofMode, "reference-fixture");
    assert.match(event.fixtureId, /^hobo-575\.migration\./);
    assert.ok(event.aggregateId.startsWith("migration/"));
  }

  const phaseEvents = prototype.eventFixtures.filter((event) => event.type === "migration.PhaseApplied");
  assert.deepEqual(
    phaseEvents.map((event) => event.payload.phase),
    ["expand", "backfill", "contract"],
  );
});

test("Gatekeeper, Pact compatibility, and can-deploy block destructive contract changes with safe next steps", () => {
  const prototype = parseCliMigrationTranscriptPrototype(CLI_MIGRATION_TRANSCRIPT_PROTOTYPE);
  const blockedContract = prototype.transcriptSteps.find(
    (step) => step.case === "blocked-destructive-contract",
  );

  assert.ok(blockedContract);
  assert.equal(blockedContract?.gateOutcome.blocked, true);
  assert.deepEqual(blockedContract?.gateOutcome.blockers, [...REQUIRED_GATEKEEPER_BLOCKERS]);
  assert.deepEqual(blockedContract?.gateOutcome.safeNextSteps, [
    "keep the old field dual-published",
    "apply expand/backfill only",
    "rerun pact compatibility and can-deploy before contract",
  ]);
  assert.match(blockedContract?.output ?? "", /breaking schema change blocked/i);
});

test("SDK and API examples describe the same migration request and result envelope", () => {
  const prototype = parseCliMigrationTranscriptPrototype(CLI_MIGRATION_TRANSCRIPT_PROTOTYPE);

  assert.deepEqual(assertMigrationExampleParity(prototype.examples), {
    equivalent: true,
    requestId: "migration-request/adopt-billing-db",
    resultCode: "migration.ready_for_cutover",
  });

  const mismatched = structuredClone(prototype.examples);
  mismatched.api.resultEnvelope.code = "migration.different";

  assert.equal(assertMigrationExampleParity(mismatched).equivalent, false);
});

test("scope guard rejects live import, live data, automatic remodeling, irreversible destruction, and hand-written down claims", () => {
  assert.throws(
    () => rejectMigrationScopeCreep("Run a real Terraform import against production state."),
    /real Terraform import is scope-out/,
  );
  assert.throws(
    () => rejectMigrationScopeCreep("Connect to live databases and copy customer data."),
    /live databases are scope-out/,
  );
  assert.throws(
    () => rejectMigrationScopeCreep("Automatically remodel MySQL tables into DynamoDB."),
    /automatic cross-engine remodelling is scope-out/,
  );
  assert.throws(
    () => rejectMigrationScopeCreep("Execute irreversible destructive migrations."),
    /irreversible destructive migrations are scope-out/,
  );
  assert.throws(
    () => rejectMigrationScopeCreep("Trust a hand-written .down migration file."),
    /hand-written down migrations are scope-out/,
  );
});

test("architecture artifacts reconcile protobuf, CUE, and Pact evidence for the transcript boundary", () => {
  const architectureDir = join(import.meta.dirname, "..", "architecture");
  const proto = readFileSync(join(architectureDir, "cli_migration_transcript_prototype.proto"), "utf8");
  const cue = readFileSync(join(architectureDir, "cli_migration_transcript_prototype.cue"), "utf8");
  // SAFETY: `const pact = JSON.parse(` is required at this I/O or test boundary.
  const pact = JSON.parse(
    readFileSync(join(architectureDir, "pacts", "cli_migration_transcript_prototype.pact.json"), "utf8"),
  ) as { consumer: { name: string }; provider: { name: string }; interactions: JsonValue[] };

  assert.match(proto, /message CliMigrationTranscriptPrototype/);
  assert.match(cue, /#CliMigrationTranscriptPrototype/);
  assert.equal(pact.consumer.name, "HOBO-575 CLI migration transcript prototype");
  assert.equal(pact.provider.name, "HoBo design proof registry");
  assert.ok(pact.interactions.length >= 1);
});
