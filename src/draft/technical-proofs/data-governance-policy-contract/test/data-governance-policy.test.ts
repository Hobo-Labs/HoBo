import assert from "node:assert/strict";
import { test } from "vitest";

import { POLICY_IR_SCHEMA_VERSION } from "../../hobo-policy-ir-contract/src/policy-ir.js";

import {
  DATA_GOVERNANCE_POLICY_ENGINE_ID,
  evaluateDataGovernancePolicy,
} from "../src/data-governance-policy.js";

function classifiedPatientRecord(overrides = {}) {
  return {
    type: "data.Classified",
    resourceId: "dataset:patient-records",
    classification: "phi",
    jurisdiction: "US",
    allowedRegions: ["us-east-1"],
    retention: {
      minDays: 2555,
      maxDays: 3650,
    },
    ...overrides,
  };
}

function decisionRequest(overrides = {}) {
  return {
    schemaVersion: POLICY_IR_SCHEMA_VERSION,
    subject: {
      kind: "agent",
      id: "agent:tenant-a/deployer",
      delegatedBy: "user:platform-admin",
      roles: ["deployer"],
      scopes: ["hobo:deployment:can-deploy"],
    },
    action: "hobo:deployment:can-deploy",
    resource: {
      kind: "camp",
      id: "camp:tenant-a/patient-api",
    },
    phase: "plan",
    context: {
      actorId: "user:platform-admin",
      campId: "camp:tenant-a/patient-api",
      region: "us-east-1",
      dataClassifications: ["phi"],
    },
    ...overrides,
  };
}

function evaluate(overrides = {}) {
  const { request: requestOverrides, ...rest } = overrides;
  return evaluateDataGovernancePolicy({
    request: decisionRequest(requestOverrides),
    classifiedData: [classifiedPatientRecord()],
    policy: {
      id: "governance:hipaa-us-residency",
    },
    ...rest,
  });
}

test("can-deploy rejects phi placement outside a permitted residency region", () => {
  const result = evaluate({
    request: {
      context: {
        region: "eu-central-1",
        dataClassifications: ["phi"],
      },
    },
  });

  assert.equal(result.decision.effect, "deny");
  assert.match(result.decision.reason, /residency/);
  assert.equal(result.decision.evidence.engine, DATA_GOVERNANCE_POLICY_ENGINE_ID);
  assert.match(result.decision.violations.join("\n"), /outside allowed regions us-east-1/);
  assert.equal(
    result.events.find((event) => event.type === "dataGovernance.ResidencyEvaluated")?.blocked,
    true,
  );
});

test("permitted Camp placement passes and records replayable policy evidence", () => {
  const result = evaluate();

  assert.equal(result.decision.effect, "allow");
  assert.deepEqual(result.classificationContext.dataClassifications, ["phi"]);
  assert.equal(result.classificationContext.region, "us-east-1");
  assert.equal(result.events.find((event) => event.type === "policy.Decided")?.data.effect, "allow");
  assert.deepEqual(result.events.find((event) => event.type === "policy.Decided")?.audit.policyIds, [
    "governance:hipaa-us-residency",
  ]);
});

test("runtime export crossing a boundary is region-pinned when a compliant channel exists", () => {
  const result = evaluate({
    request: {
      action: "hobo:runtime:export",
      phase: "runtime",
      context: {
        region: "us-east-1",
        dataClassifications: ["phi"],
      },
    },
    runtimeAction: {
      kind: "export",
      destinationRegion: "eu-central-1",
      allowRegionPinning: true,
      pinnedRegion: "us-east-1",
      pinnedEndpoint: "https://us-east-1.example.invalid/export",
      endpointCompliance: "compliant",
    },
  });

  assert.equal(result.decision.effect, "mutate");
  assert.deepEqual(result.decision.mutations, [
    {
      kind: "governance.pin-runtime-region",
      fromRegion: "eu-central-1",
      toRegion: "us-east-1",
      endpoint: "https://us-east-1.example.invalid/export",
    },
  ]);
});

test("runtime action to a non-compliant endpoint fails obligation instead of warning", () => {
  const result = evaluate({
    request: {
      action: "hobo:runtime:export",
      phase: "runtime",
      context: {
        region: "us-east-1",
        dataClassifications: ["phi"],
      },
    },
    runtimeAction: {
      kind: "export",
      destinationRegion: "eu-central-1",
      endpointCompliance: "non-compliant",
    },
  });

  assert.equal(result.decision.effect, "deny");
  assert.match(result.decision.reason, /runtime boundary obligation failed/);
  assert.equal(result.decision.obligations.some((obligation) => obligation.kind === "warn"), false);
});

test("runtime region pinning requires explicit compliant endpoint evidence", () => {
  const result = evaluate({
    request: {
      action: "hobo:runtime:export",
      phase: "runtime",
      context: {
        region: "us-east-1",
        dataClassifications: ["phi"],
      },
    },
    runtimeAction: {
      kind: "export",
      destinationRegion: "eu-central-1",
      allowRegionPinning: true,
      pinnedRegion: "us-east-1",
      pinnedEndpoint: "https://us-east-1.example.invalid/export",
    },
  });

  assert.equal(result.decision.effect, "deny");
  assert.match(result.decision.violations.join("\n"), /outside allowed regions us-east-1/);
  assert.deepEqual(result.decision.mutations, []);
});

test("retention policy is enforced as a floor and a ceiling over compaction", () => {
  const deleteTooSoon = evaluate({
    retentionRequest: {
      resourceId: "dataset:patient-records",
      deleteAfterDays: 90,
    },
  });
  const keepTooLong = evaluate({
    retentionRequest: {
      resourceId: "dataset:patient-records",
      retainForDays: 4000,
    },
  });
  const validWindow = evaluate({
    retentionRequest: {
      resourceId: "dataset:patient-records",
      deleteAfterDays: 3000,
      retainForDays: 3000,
    },
  });

  assert.equal(deleteTooSoon.decision.effect, "deny");
  assert.match(deleteTooSoon.decision.violations.join("\n"), /below retention floor 2555/);
  assert.equal(keepTooLong.decision.effect, "deny");
  assert.match(keepTooLong.decision.violations.join("\n"), /past retention ceiling 3650/);
  assert.equal(validWindow.decision.effect, "allow");
});

test("unregistered subprocessors fail the can-deploy gate instead of being allowed with a log", () => {
  const result = evaluate({
    request: {
      action: "hobo:deployment:can-deploy",
      phase: "plan",
      context: {
        region: "us-east-1",
        dataClassifications: ["phi"],
      },
    },
    runtimeAction: {
      kind: "export",
      destinationRegion: "us-east-1",
      subprocessorId: "processor:unknown-analytics",
      endpointCompliance: "compliant",
    },
    subprocessorRegistry: [
      {
        id: "processor:registered-hipaa-analytics",
        allowedRegions: ["us-east-1"],
        allowedClassifications: ["phi"],
      },
    ],
  });

  assert.equal(result.decision.effect, "deny");
  assert.match(result.decision.violations.join("\n"), /unregistered subprocessor/);
  assert.equal(result.events.find((event) => event.type === "dataGovernance.SubprocessorEvaluated")?.blocked, true);
});

test("public-declared PII coverage finding fails residency closed", () => {
  const result = evaluate({
    request: {
      context: {
        region: "eu-central-1",
        dataClassifications: ["public"],
      },
    },
    classifiedData: [
      classifiedPatientRecord({
        classification: "public",
        allowedRegions: ["global"],
        retention: {
          minDays: 0,
          maxDays: 365,
        },
      }),
    ],
    coverageFindings: [
      {
        type: "data.ClassificationCoverageFinding",
        resourceId: "dataset:patient-records",
        declaredClassification: "public",
        detectedClassification: "pii",
        status: "open",
      },
    ],
  });

  assert.equal(result.decision.effect, "deny");
  assert.match(result.decision.reason, /coverage/);
  assert.match(result.decision.violations.join("\n"), /declared public but detected pii/);
  assert.equal(result.events.find((event) => event.type === "dataGovernance.CoverageMismatch")?.blocked, true);
});

test("malformed classification context fails closed before policy evaluation", () => {
  assert.throws(
    () =>
      evaluate({
        request: {
          context: {
            region: "us-east-1",
            dataClassifications: "phi",
          },
        },
      }),
    /request\.context\.dataClassifications must be an array/,
  );
});

test("classified policy context without a data.Classified fact fails closed", () => {
  const result = evaluate({
    classifiedData: [],
    request: {
      context: {
        region: "us-east-1",
        dataClassifications: ["phi"],
      },
    },
  });

  assert.equal(result.decision.effect, "deny");
  assert.match(result.decision.violations.join("\n"), /no matching data\.Classified source fact/);
  assert.equal(
    result.events.find((event) => event.type === "dataGovernance.ClassificationSourceMissing")?.blocked,
    true,
  );
});

test("classified policy context without a matching data.Classified fact fails closed", () => {
  const result = evaluate({
    classifiedData: [
      classifiedPatientRecord({
        classification: "public",
        allowedRegions: ["global"],
        retention: {
          minDays: 0,
          maxDays: 365,
        },
      }),
    ],
    request: {
      context: {
        region: "eu-central-1",
        dataClassifications: ["phi"],
      },
    },
  });

  assert.equal(result.decision.effect, "deny");
  assert.match(result.decision.violations.join("\n"), /classified as phi has no matching data\.Classified source fact/);
  assert.equal(
    result.events.find((event) => event.type === "dataGovernance.ClassificationSourceMissing")?.blocked,
    true,
  );
});
