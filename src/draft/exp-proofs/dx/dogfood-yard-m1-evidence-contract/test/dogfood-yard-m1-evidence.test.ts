import assert from "node:assert/strict";
import { test } from "vitest";
import { type JsonValue } from "../src/json.js";


const contract = await import("../src/dogfood-yard-m1-evidence.ts").catch(() => null);

test("M1 dogfood evidence gate records required evidence and owning projects", () => {
  assert.ok(contract, "dogfood M1 evidence module should exist");

  const { DOGFOOD_YARD_M1_EVIDENCE, parseDogfoodYardM1Evidence } = contract;

  const parsed = parseDogfoodYardM1Evidence(DOGFOOD_YARD_M1_EVIDENCE);

  assert.equal(parsed.parsedDogfoodYardM1Evidence, true);
  assert.equal(DOGFOOD_YARD_M1_EVIDENCE.issue, "HOBO-455");
  assert.equal(DOGFOOD_YARD_M1_EVIDENCE.project, "V1 Dogfood Yard & Hosted Operations");
  assert.equal(DOGFOOD_YARD_M1_EVIDENCE.phase, "M1");
  assert.match(DOGFOOD_YARD_M1_EVIDENCE.milestoneGate, /dogfood\/alpha proof/i);
  assert.deepEqual(
    DOGFOOD_YARD_M1_EVIDENCE.requiredEvidence.map((evidence: { id: string }) => evidence.id),
    [
      "scenario-fixture-manifest",
      "safe-telemetry-bundle",
      "rollback-or-recovery-path",
      "gap-classification-ledger",
      "cutline-dependency-map",
    ],
  );
});

test("M1 evidence covers hosted, self-hosted, upgrade, and incident dogfood scenarios", () => {
  assert.ok(contract, "dogfood M1 evidence module should exist");

  const { DOGFOOD_YARD_M1_EVIDENCE } = contract;

  assert.deepEqual(
    DOGFOOD_YARD_M1_EVIDENCE.scenarioEvidence.map((scenario: { id: string }) => scenario.id),
    [
      "hosted-yard-preview-path",
      "self-hosted-seed-handover",
      "yard-upgrade-and-rollback",
      "incident-debug-and-restore",
    ],
  );
  assert.equal(
    DOGFOOD_YARD_M1_EVIDENCE.scenarioEvidence.every(
      (scenario: { evidence: string[]; cutlineImpact: string; ownerProject: string }) =>
        scenario.ownerProject === "V1 Dogfood Yard & Hosted Operations" &&
        scenario.evidence.length >= 3 &&
        scenario.cutlineImpact.length > 0,
    ),
    true,
  );
});

test("acceptance maps blockers, risks, release cutline dependencies, and follow-ups", () => {
  assert.ok(contract, "dogfood M1 evidence module should exist");

  const { DOGFOOD_YARD_M1_EVIDENCE } = contract;

  assert.ok(
    DOGFOOD_YARD_M1_EVIDENCE.cutlineDependencies.some(
      (dependency: { owner: string; evidenceNeeded: string }) =>
        dependency.owner === "V1 Release Program & Cutline" &&
        /release/i.test(dependency.evidenceNeeded),
    ),
  );
  assert.ok(
    DOGFOOD_YARD_M1_EVIDENCE.cutlineDependencies.some(
      (dependency: { owner: string }) => dependency.owner === "V1 Release Notes & Upgrade Guide",
    ),
  );
  assert.deepEqual(
    DOGFOOD_YARD_M1_EVIDENCE.gapRoutes.map((route: { decision: string }) => route.decision),
    ["beta-blocker", "launch-note", "follow-up-work"],
  );
  assert.equal(
    DOGFOOD_YARD_M1_EVIDENCE.followUpPolicy.createOnlyWhereEvidenceMissing,
    true,
  );
});

test("parser rejects live provider calls, customer data, readiness claims, and runtime build work", () => {
  assert.ok(contract, "dogfood M1 evidence module should exist");

  const {
    DOGFOOD_YARD_M1_EVIDENCE,
    DogfoodYardM1EvidenceParseError,
    parseDogfoodYardM1Evidence,
  } = contract;

  assert.throws(
    () =>
      parseDogfoodYardM1Evidence({
        ...DOGFOOD_YARD_M1_EVIDENCE,
        scopeIn: [
          ...DOGFOOD_YARD_M1_EVIDENCE.scopeIn,
          "Build hosted Yard runtime, run production provider calls, inspect live customer data, and mark beta readiness.",
        ],
      }),
    (error: JsonValue) => {
      assert.equal(error instanceof DogfoodYardM1EvidenceParseError, true);
      const details = error instanceof DogfoodYardM1EvidenceParseError ? error.errors.join("\n") : String(error);
      assert.match(details, /runtime/i);
      assert.match(details, /production provider/i);
      assert.match(details, /live customer data/i);
      assert.match(details, /readiness/i);
      return true;
    },
  );
});

test("decision classifier keeps adjacent work with owning initiatives", () => {
  assert.ok(contract, "dogfood M1 evidence module should exist");

  const { classifyDogfoodM1Decision } = contract;

  assert.deepEqual(classifyDogfoodM1Decision("record safe dogfood telemetry bundle"), {
    owner: "V1 Dogfood Yard & Hosted Operations",
    inScope: true,
  });
  assert.equal(classifyDogfoodM1Decision("build admin status page controls").owner, "Admin Console");
  assert.equal(classifyDogfoodM1Decision("implement bootstrap installer command").owner, "Bootstrap Installer");
  assert.equal(classifyDogfoodM1Decision("publish release notes limitation").owner, "V1 Release Notes & Upgrade Guide");
  assert.equal(classifyDogfoodM1Decision("change public launch cutline").owner, "V1 Release Program & Cutline");
});
