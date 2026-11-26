import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  CONTROL_PLANE_EVENT_TYPES,
  CORE_EVENT_ENVELOPE_COMPATIBILITY,
  createDispatchDecidedEvent,
  createFixtureEventForType,
  createGoldenDeploySequence,
  createMatchDecidedEvent,
  createPlannedEvent,
  deserializeEvent,
  parseControlPlaneEventWithZod,
  planContentAddress,
  REQUIRED_EVENT_BODY_FIELDS,
  roundTripEvent,
  roundTripEventThroughProtobuf,
  serializeEvent,
  stableDigest,
  upcastEvent,
  validateControlPlaneEvent
} from "../src/control-plane-events.js";
import { isJsonString } from "../src/json.js";


const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("schemas publish every control-plane event type and round-trip through the contract codec", async () => {
  const schemaText = await readFile(
    path.join(packageRoot, "schema", "control-plane-events.v1.schema.json"),
    "utf8"
  );
  const protoText = await readFile(
    path.join(packageRoot, "proto", "control_plane_events.proto"),
    "utf8"
  );
  const schema = JSON.parse(schemaText);

  assert.deepEqual(schema.properties.type.enum, CONTROL_PLANE_EVENT_TYPES);
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.deepEqual(schema.required, CORE_EVENT_ENVELOPE_COMPATIBILITY.requiredFields);
  assert.deepEqual(schema["x-hobo-requiredBodyFields"], REQUIRED_EVENT_BODY_FIELDS);
  assert.match(protoText, /message ControlPlaneEvent/);
  assert.match(protoText, /message MatchDecided/);

  const protoPath = path.join(packageRoot, "proto", "control_plane_events.proto");
  for (const event of createGoldenDeploySequence()) {
    const validation = validateControlPlaneEvent(event);
    assert.equal(validation.ok, true, validation.errors.join("\n"));
    assert.deepEqual(deserializeEvent(serializeEvent(event)), event);
    assert.deepEqual(roundTripEvent(event), event);
    assert.deepEqual(parseControlPlaneEventWithZod(event), event);
    assert.deepEqual(await roundTripEventThroughProtobuf(event, protoPath), event);
  }
});

test("golden deploy sequence records planning, matching, set, delta, resource, exec, dispatch, and deployed facts", () => {
  const events = createGoldenDeploySequence();

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "deployment.Planned",
      "match.Decided",
      "set.Created",
      "delta.Opened",
      "delta.Updated",
      "delta.Applied",
      "resource.Pending",
      "resource.Provisioning",
      "exec.Started",
      "exec.Output",
      "exec.Succeeded",
      "resource.Provisioned",
      "dispatch.Decided",
      "deployment.Deployed"
    ]
  );
  assert.equal(new Set(events.map((event) => event.correlationId)).size, 1);
  assert.ok(events.every((event) => isJsonString(event.causationId) && event.causationId.length > 0));
});

test("deployment.Planned content-addresses the deterministic DeploymentPlan payload", () => {
  const plan = {
    deploymentId: "dep-gallery-prod",
    nodes: [
      { name: "assets", port: "wasi:blobstore/blobstore", provider: "aws", deps: [] },
      { name: "api", port: "hobo:runtime/workflow", provider: "aws", deps: ["assets"] }
    ],
    meta: {
      objective: "cost",
      matchDecisionIds: ["match-assets"]
    }
  };
  const planned = createPlannedEvent(plan);

  assert.equal(planned.type, "deployment.Planned");
  assert.equal(planned.data.planHash, planContentAddress(plan));
  assert.equal(planContentAddress(plan), stableDigest(plan));
});

test("match.Decided carries ADR-0033 ranking, rejected candidates, objective, tie flag, and catalog hash", () => {
  const decided = createMatchDecidedEvent({
    resourceId: "assets",
    winner: "aws-s3-standard",
    objective: "cost",
    catalogContentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ranking: [
      {
        definitionId: "aws-s3-standard",
        region: "us-east-1",
        specificity: 2,
        priority: 10,
        objectiveScore: 0.13,
        rank: 1,
        rationale: "objective=cost; region=us-east-1; provider=aws"
      },
      { definitionId: "azure-blob-standard", specificity: 2, priority: 10, objectiveScore: 0.17, rank: 2 }
    ],
    rejectedCandidates: [
      { definitionId: "local-minio", reason: "require objectStore.replication=full was not satisfied" }
    ],
    tie: false
  });

  const validation = validateControlPlaneEvent(decided);

  assert.equal(validation.ok, true, validation.errors.join("\n"));
  assert.deepEqual(Object.keys(decided.data).sort(), [
    "catalogContentHash",
    "objective",
    "ranking",
    "rejectedCandidates",
    "resourceId",
    "tie",
    "winner"
  ]);
  assert.equal(decided.data.tie, false);
  assert.equal(decided.data.ranking[0].region, "us-east-1");
  assert.match(decided.data.ranking[0].rationale, /objective=cost/);
});

test("dispatch.Decided pins the CreditLedgerView seq and reservation input used by maximize-credits", () => {
  const decided = createDispatchDecidedEvent({
    dispatchId: "build-api-image",
    category: "build-machine",
    selectedProvider: "depot",
    objective: "maximize-credits",
    ledgerInput: {
      view: "CreditLedgerView",
      seq: 1844,
      reservationId: "reserve-build-api-image",
      balanceHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    },
    candidates: [
      { provider: "github", effectiveMarginalCost: 0.04, rationale: "paid runner" },
      { provider: "depot", effectiveMarginalCost: 0, rationale: "free credit available" }
    ]
  });

  const validation = validateControlPlaneEvent(decided);

  assert.equal(validation.ok, true, validation.errors.join("\n"));
  assert.equal(decided.data.ledgerInput.seq, 1844);
  assert.equal(decided.data.objective, "maximize-credits");
  assert.match(decided.data.candidates[1].rationale, /free credit/);
});

test("adversarial validation rejects missing envelope linkage and absent current tie flag", () => {
  const noCorrelation = createGoldenDeploySequence()[0];
  delete noCorrelation.correlationId;

  const missingTie = createMatchDecidedEvent({
    resourceId: "assets",
    winner: "aws-s3-standard",
    objective: "cost",
    catalogContentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ranking: [{ definitionId: "aws-s3-standard", specificity: 1, priority: 0, objectiveScore: 1, rank: 1 }],
    rejectedCandidates: [],
    tie: false
  });
  delete missingTie.data.tie;

  assert.match(validateControlPlaneEvent(noCorrelation).errors.join("\n"), /correlationId is required/);
  assert.match(validateControlPlaneEvent(missingTie).errors.join("\n"), /match.Decided tie must be a boolean/);
});

test("legacy match.Decided bodies upcast tie=false but broken event bodies fail with precise reasons", () => {
  const oldEvent = {
    ...createMatchDecidedEvent({
      resourceId: "assets",
      winner: "aws-s3-standard",
      objective: "cost",
      catalogContentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ranking: [{ definitionId: "aws-s3-standard", specificity: 1, priority: 0, objectiveScore: 1, rank: 1 }],
      rejectedCandidates: []
    }),
    schemaVersion: 0
  };
  delete oldEvent.data.tie;

  const upcasted = upcastEvent(oldEvent);

  assert.equal(upcasted.schemaVersion, 1);
  assert.equal(upcasted.data.tie, false);
  assert.equal(validateControlPlaneEvent(upcasted).ok, true);
  assert.match(
    validateControlPlaneEvent({ ...upcasted, data: { ...upcasted.data, catalogContentHash: "latest" } }).errors.join("\n"),
    /catalogContentHash must be sha256/
  );
});

test("body validators reject wrong shapes, not just missing fields", () => {
  const invalidSet = createFixtureEventForType("set.Created");
  invalidSet.data.contentHash = "latest";
  assert.match(validateControlPlaneEvent(invalidSet).errors.join("\n"), /set.Created contentHash/);

  const invalidDelta = createFixtureEventForType("delta.Updated");
  invalidDelta.data.operations = "add api";
  assert.match(validateControlPlaneEvent(invalidDelta).errors.join("\n"), /delta.Updated operations/);

  const invalidDeploy = createFixtureEventForType("deployment.Deployed");
  invalidDeploy.data.resourceIds = "assets,api";
  assert.match(validateControlPlaneEvent(invalidDeploy).errors.join("\n"), /deployment.Deployed resourceIds/);

  const invalidExec = createFixtureEventForType("exec.Output");
  invalidExec.data.stream = "debug";
  assert.match(validateControlPlaneEvent(invalidExec).errors.join("\n"), /exec.Output stream/);
});

test("generated contract surface stays in sync with schema event enum", async () => {
  const generatedTypes = await readFile(
    path.join(packageRoot, "src", "generated", "control-plane-event-types.ts"),
    "utf8"
  );
  const declarations = await readFile(
    path.join(packageRoot, "src", "control-plane-events.d.ts"),
    "utf8"
  );

  for (const eventType of CONTROL_PLANE_EVENT_TYPES) {
    assert.match(generatedTypes, new RegExp(JSON.stringify(eventType)));
    assert.match(declarations, new RegExp(eventType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("every declared event type has an enforced body schema", () => {
  for (const eventType of CONTROL_PLANE_EVENT_TYPES) {
    const event = createFixtureEventForType(eventType);
    const validation = validateControlPlaneEvent(event);
    assert.equal(validation.ok, true, `${eventType}: ${validation.errors.join("\n")}`);

    const requiredField = REQUIRED_EVENT_BODY_FIELDS[eventType][0];
    const missingField = {
      ...event,
      data: { ...event.data }
    };
    delete missingField.data[requiredField];

    assert.match(
      validateControlPlaneEvent(missingField).errors.join("\n"),
      new RegExp(`${eventType} ${requiredField} is required`)
    );
  }
});
