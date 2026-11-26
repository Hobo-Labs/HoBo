import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  attemptSeedCredentialReuse,
  restoreSelfHostedYardFromLog,
  runDevopsSelfHostYardJourney,
} from "../src/devops-self-host-yard-journey.js";

describe("DevOps self-host Yard journey contract", () => {
  it("runs seed, host-azure, restore, and upgrade through the same hobo up gate", () => {
    const journey = runDevopsSelfHostYardJourney();

    assert.equal(journey.status, "self-hosted");
    assert.deepEqual(
      journey.commands.map((command) => command.command),
      [
        "hobo up ./platform --seed",
        "hobo up ./platform --camp host-azure",
        "hobo up ./platform --restore eventlog://yard-prod/last-good",
        "hobo up ./platform",
      ],
    );
    assert.ok(journey.commands.every((command) => command.exitCode === 0));
    assert.equal(countEvents(journey.events, "identity.SeedTokenUsed"), 1);
    assert.equal(countEvents(journey.events, "token.Revoked"), 1);
    assert.equal(countEvents(journey.events, "seed.Discarded"), 1);
    assert.equal(journey.seed.status, "retired");
    assert.equal(journey.selfHostedYard.reachable, true);
    assert.equal(journey.selfHostedYard.controlPlaneHost, "host-azure");
    assert.equal(journey.selfHostedYard.identityBroker, "real-yard-identity");
    assert.equal(journey.restore.status, "restored");
    assert.equal(journey.restore.setRef, journey.selfHostedYard.lastGoodSetRef);
    assert.equal(journey.upgrade.status, "applied");
    assert.equal(journey.upgrade.gate, "hobo.up");
  });

  it("leaves the seed recoverable and refuses success when phase two fails", () => {
    const journey = runDevopsSelfHostYardJourney({
      phase2Failure: "operator-credential-expired-mid-apply",
    });

    assert.equal(journey.status, "recoverable");
    assert.equal(journey.seed.status, "recoverable");
    assert.equal(journey.selfHostedYard, null);
    assert.equal(journey.commands.at(-1).command, "hobo up ./platform --camp host-azure");
    assert.equal(journey.commands.at(-1).exitCode, 1);
    assert.match(journey.commands.at(-1).stderr, /operator-credential-expired-mid-apply/);
    assert.equal(countEvents(journey.events, "yard.Live"), 0);
    assert.equal(countEvents(journey.events, "seed.Discarded"), 0);
  });

  it("denies seed credential reuse after handover without recording a second use", () => {
    const journey = runDevopsSelfHostYardJourney();
    const reuse = attemptSeedCredentialReuse(journey);

    assert.equal(reuse.allowed, false);
    assert.equal(reuse.reason, "seed-credential-retired");
    assert.equal(reuse.audit.seedTokenUseCount, 1);
    assert.equal(countEvents(reuse.events, "identity.SeedTokenUsed"), 0);
  });

  it("refuses corrupt and partial restore logs before rebuilding the control plane", () => {
    const journey = runDevopsSelfHostYardJourney();

    assert.throws(
      () =>
        restoreSelfHostedYardFromLog({
          ...journey.seedLog,
          hash: "sha256:tampered",
        }),
      /restore-log-hash-mismatch/,
    );
    assert.throws(
      () =>
        restoreSelfHostedYardFromLog({
          ...journey.seedLog,
          events: journey.seedLog.events.filter((event) => event.type !== "bootstrap.Completed"),
          hash: "sha256:partial",
        }),
      /restore-log-incomplete/,
    );
  });

  it("rolls back a failed upgrade through the hobo up gate", () => {
    const journey = runDevopsSelfHostYardJourney({
      upgradeGate: { status: "failed", reason: "schema migration failed" },
    });

    assert.equal(journey.status, "self-hosted");
    assert.equal(journey.upgrade.status, "rolled-back");
    assert.equal(journey.upgrade.reason, "schema migration failed");
    assert.equal(journey.selfHostedYard.activeSetRef, "set:yard@sha256-bootstrap");
    assert.equal(countEvents(journey.events, "yard.UpgradeRolledBack"), 1);
    assert.equal(countEvents(journey.events, "yard.UpgradeApplied"), 0);
  });

  it("keeps control-plane state off the operator laptop after the seed phase", () => {
    const journey = runDevopsSelfHostYardJourney();

    assert.equal(journey.operatorLaptop.role, "cli-client-only");
    assert.equal(journey.operatorLaptop.storesControlPlaneState, false);
    assert.equal(journey.seed.runtime, "@hobo/runtime-local");
    assert.deepEqual(
      journey.events.filter((event) => event.data?.stateOwner === "operator-laptop" || event.data?.controlPlaneHost === "operator-laptop"),
      [],
    );
  });
});

function countEvents(events, type) {
  return events.filter((event) => event.type === type).length;
}
