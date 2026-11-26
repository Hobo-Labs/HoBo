import { createHash } from "node:crypto";
import protobuf from "protobufjs";
import { z } from "zod";

import {
  GENERATED_CONTROL_PLANE_EVENT_TYPES,
  GENERATED_REQUIRED_EVENT_BODY_FIELDS
} from "./generated/control-plane-event-types.js";
import { isJsonString, isJsonNumber, isJsonBoolean, isJsonObject } from "./json.js";


export const CURRENT_SCHEMA_VERSION = 1;

export const CONTROL_PLANE_EVENT_TYPES = Object.freeze([...GENERATED_CONTROL_PLANE_EVENT_TYPES]);

const CONTROL_PLANE_TYPE_SET = new Set(CONTROL_PLANE_EVENT_TYPES);
const OBJECTIVES = new Set(["cost", "latency", "single-provider", "carbon", "maximize-credits"]);
const SHA256_REF = /^sha256:[a-f0-9]{64}$/;

export const REQUIRED_EVENT_BODY_FIELDS = Object.freeze({ ...GENERATED_REQUIRED_EVENT_BODY_FIELDS });

export const CORE_EVENT_ENVELOPE_COMPATIBILITY = Object.freeze({
  ref: "@hobo/core/EventEnvelope@v1",
  requiredFields: Object.freeze([
    "id",
    "type",
    "schemaVersion",
    "tenant",
    "seq",
    "time",
    "actor",
    "correlationId",
    "causationId",
    "data"
  ])
});

const HashRefZod = z.string().regex(SHA256_REF);
const JsonObjectZod = z.record(z.string(), z.unknown());
const ActorZod = z.object({
  kind: z.enum(["user", "agent", "service"]),
  id: z.string().min(1)
}).strict();
const RankedDefinitionZod = z.object({
  definitionId: z.string().min(1),
  region: z.string().min(1).optional(),
  specificity: z.number(),
  priority: z.number(),
  objectiveScore: z.number(),
  rank: z.number(),
  rationale: z.string().min(1).optional()
}).strict();
const RejectedCandidateZod = z.object({
  definitionId: z.string().min(1),
  reason: z.string().min(1)
}).strict();
const DispatchCandidateZod = z.object({
  provider: z.string().min(1),
  effectiveMarginalCost: z.number(),
  rationale: z.string().min(1).optional()
}).strict();
const LedgerInputZod = z.object({
  view: z.literal("CreditLedgerView"),
  seq: z.number().int().nonnegative(),
  reservationId: z.string().min(1),
  balanceHash: HashRefZod
}).strict();

export const CONTROL_PLANE_BODY_ZOD_SCHEMAS = Object.freeze({
  "deployment.Planned": z.object({ plan: JsonObjectZod, planHash: z.string().min(1) }).strict(),
  "deployment.PlanRejected": z.object({ deploymentId: z.string().min(1), reason: z.string().min(1) }).strict(),
  "match.Decided": z.object({
    resourceId: z.string().min(1),
    winner: z.string().min(1),
    ranking: z.array(RankedDefinitionZod).min(1),
    rejectedCandidates: z.array(RejectedCandidateZod),
    objective: z.enum([...OBJECTIVES]),
    tie: z.boolean(),
    catalogContentHash: HashRefZod
  }).strict(),
  "set.Created": z.object({
    setId: z.string().min(1),
    campId: z.string().min(1),
    contentHash: HashRefZod,
    sourcePlanHash: z.string().min(1).optional()
  }).strict(),
  "delta.Opened": z.object({
    deltaId: z.string().min(1),
    baseSetId: z.string().min(1),
    author: z.string().min(1).optional()
  }).strict(),
  "delta.Updated": z.object({ deltaId: z.string().min(1), operations: z.array(JsonObjectZod) }).strict(),
  "delta.Applied": z.object({ deltaId: z.string().min(1), resultingSetId: z.string().min(1) }).strict(),
  "resource.Pending": z.object({ resourceId: z.string().min(1), deps: z.array(z.string()) }).strict(),
  "resource.Provisioning": z.object({
    resourceId: z.string().min(1),
    provider: z.string().min(1),
    driver: z.string().min(1)
  }).strict(),
  "resource.Provisioned": z.object({ resourceId: z.string().min(1), outputs: JsonObjectZod }).strict(),
  "resource.DriftDetected": z.object({
    resourceId: z.string().min(1),
    driftFingerprint: z.string().min(1),
    providerStateHash: z.string().min(1),
    desiredStateHash: z.string().min(1),
    changes: z.array(JsonObjectZod)
  }).strict(),
  "resource.DriftQueued": z.object({
    resourceId: z.string().min(1),
    driftFingerprint: z.string().min(1),
    leaseHolder: z.string().min(1)
  }).strict(),
  "resource.Updating": z.object({
    resourceId: z.string().min(1),
    previousVersion: z.string().min(1),
    targetVersion: z.string().min(1),
    driftFingerprint: z.string().min(1).optional()
  }).strict(),
  "resource.RefreshFailed": z.object({
    resourceId: z.string().min(1),
    classification: z.enum(["retryable", "fatal", "ambiguous"]),
    reason: z.string().min(1),
    retryAfterMs: z.number().int().positive()
  }).strict(),
  "resource.DriftSuppressed": z.object({
    resourceId: z.string().min(1),
    driftFingerprint: z.string().min(1),
    reason: z.string().min(1)
  }).strict(),
  "resource.Failed": z.object({ resourceId: z.string().min(1), reason: z.string().min(1) }).strict(),
  "resource.Destroying": z.object({ resourceId: z.string().min(1), reason: z.string().min(1) }).strict(),
  "resource.Destroyed": z.object({ resourceId: z.string().min(1), finalStateHash: HashRefZod }).strict(),
  "resource.Adopted": z.object({ resourceId: z.string().min(1), externalId: z.string().min(1) }).strict(),
  "exec.Started": z.object({
    execId: z.string().min(1),
    resourceId: z.string().min(1),
    programHash: HashRefZod
  }).strict(),
  "exec.Output": z.object({
    execId: z.string().min(1),
    stream: z.enum(["stdout", "stderr"]),
    line: z.string()
  }).strict(),
  "exec.Succeeded": z.object({ execId: z.string().min(1), outputsHash: HashRefZod }).strict(),
  "exec.Failed": z.object({ execId: z.string().min(1), reason: z.string().min(1) }).strict(),
  "dispatch.Decided": z.object({
    dispatchId: z.string().min(1),
    category: z.string().min(1),
    selectedProvider: z.string().min(1),
    objective: z.enum([...OBJECTIVES]),
    ledgerInput: LedgerInputZod,
    candidates: z.array(DispatchCandidateZod).min(1)
  }).strict(),
  "deployment.RolledBack": z.object({
    deploymentId: z.string().min(1),
    targetSetId: z.string().min(1),
    reason: z.string().min(1)
  }).strict(),
  "deployment.Deployed": z.object({
    deploymentId: z.string().min(1),
    setId: z.string().min(1),
    resourceIds: z.array(z.string().min(1))
  }).strict()
});

export const ControlPlaneEventZodSchema = z.object({
  id: z.string().min(1),
  type: z.enum(CONTROL_PLANE_EVENT_TYPES),
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  tenant: z.string().min(1),
  seq: z.number().int().nonnegative(),
  time: z.string().min(1),
  actor: ActorZod,
  correlationId: z.string().min(1),
  causationId: z.string().min(1),
  data: JsonObjectZod
}).strict();

export function canonicalJson(value) {
  return JSON.stringify(sortForCanonicalJson(value));
}

export function stableDigest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function planContentAddress(plan) {
  return stableDigest(plan);
}

export function serializeEvent(event) {
  return canonicalJson(event);
}

export function deserializeEvent(serialized) {
  return JSON.parse(serialized);
}

export function roundTripEvent(event) {
  return deserializeEvent(serializeEvent(event));
}

export function parseControlPlaneEventWithZod(event) {
  const envelope = ControlPlaneEventZodSchema.parse(event);
  const dataSchema = CONTROL_PLANE_BODY_ZOD_SCHEMAS[envelope.type];
  return {
    ...envelope,
    data: dataSchema.parse(envelope.data)
  };
}

export async function roundTripEventThroughProtobuf(event, protoPath) {
  const root = await protobuf.load(protoPath);
  const ControlPlaneEvent = root.lookupType("hobo.control_plane.events.v1.ControlPlaneEvent");
  const payload = {
    id: event.id,
    type: event.type,
    schemaVersion: event.schemaVersion,
    tenant: event.tenant,
    seq: event.seq,
    time: event.time,
    actor: event.actor,
    correlationId: event.correlationId,
    causationId: event.causationId,
    dataJson: Buffer.from(canonicalJson(event.data))
  };
  const error = ControlPlaneEvent.verify(payload);
  if (error) {
    throw new Error(error);
  }
  const bytes = ControlPlaneEvent.encode(ControlPlaneEvent.create(payload)).finish();
  const decoded = ControlPlaneEvent.toObject(ControlPlaneEvent.decode(bytes), {
    bytes: Buffer,
    longs: Number
  });

  return {
    id: decoded.id,
    type: decoded.type,
    schemaVersion: decoded.schemaVersion,
    tenant: decoded.tenant,
    seq: decoded.seq,
    time: decoded.time,
    actor: decoded.actor,
    correlationId: decoded.correlationId,
    causationId: decoded.causationId,
    data: JSON.parse(Buffer.from(decoded.dataJson).toString("utf8"))
  };
}

export function createPlannedEvent(plan, overrides = {}) {
  return createEvent("deployment.Planned", {
    plan,
    planHash: planContentAddress(plan)
  }, overrides);
}

export function createMatchDecidedEvent({
  resourceId,
  winner,
  ranking,
  rejectedCandidates,
  objective,
  catalogContentHash,
  tie = false
}, overrides = {}) {
  return createEvent("match.Decided", {
    resourceId,
    winner,
    ranking,
    rejectedCandidates,
    objective,
    tie,
    catalogContentHash
  }, overrides);
}

export function createDispatchDecidedEvent({
  dispatchId,
  category,
  selectedProvider,
  objective,
  ledgerInput,
  candidates
}, overrides = {}) {
  return createEvent("dispatch.Decided", {
    dispatchId,
    category,
    selectedProvider,
    objective,
    ledgerInput,
    candidates
  }, overrides);
}

export function createFixtureEventForType(type, overrides = {}) {
  if (type === "deployment.Planned") {
    return createPlannedEvent(fixturePlan(), overrides);
  }
  if (type === "match.Decided") {
    return createMatchDecidedEvent(fixtureMatchBody(), overrides);
  }
  if (type === "dispatch.Decided") {
    return createDispatchDecidedEvent(fixtureDispatchBody(), overrides);
  }

  const dataByType = {
    "deployment.PlanRejected": {
      deploymentId: "dep-gallery-prod",
      reason: "require objectStore.replication=full was not satisfied"
    },
    "set.Created": {
      setId: "set-prod-0001",
      campId: "prod-aws",
      contentHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    },
    "delta.Opened": {
      deltaId: "delta-prod-0002",
      baseSetId: "set-prod-0001"
    },
    "delta.Updated": {
      deltaId: "delta-prod-0002",
      operations: [{ op: "add", resourceId: "api" }]
    },
    "delta.Applied": {
      deltaId: "delta-prod-0002",
      resultingSetId: "set-prod-0002"
    },
    "resource.Pending": {
      resourceId: "assets",
      deps: []
    },
    "resource.Provisioning": {
      resourceId: "assets",
      provider: "aws",
      driver: "iac-pulumi"
    },
    "resource.Provisioned": {
      resourceId: "assets",
      outputs: { bucketName: "gallery-prod-assets" }
    },
    "resource.DriftDetected": {
      resourceId: "assets",
      driftFingerprint: "sha256:drift-assets",
      providerStateHash: "sha256:actual-assets",
      desiredStateHash: "sha256:desired-assets",
      changes: [{ path: "instanceSize", expected: "small", actual: "large" }]
    },
    "resource.DriftQueued": {
      resourceId: "assets",
      driftFingerprint: "sha256:drift-assets",
      leaseHolder: "deploy-apply"
    },
    "resource.Updating": {
      resourceId: "assets",
      previousVersion: "set-prod-0001",
      targetVersion: "set-prod-0002"
    },
    "resource.RefreshFailed": {
      resourceId: "assets",
      classification: "retryable",
      reason: "provider timeout",
      retryAfterMs: 30000
    },
    "resource.DriftSuppressed": {
      resourceId: "assets",
      driftFingerprint: "sha256:drift-assets",
      reason: "same drift fingerprint already attempted"
    },
    "resource.Failed": {
      resourceId: "assets",
      reason: "provider timeout"
    },
    "resource.Destroying": {
      resourceId: "assets",
      reason: "delta removed resource"
    },
    "resource.Destroyed": {
      resourceId: "assets",
      finalStateHash: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    },
    "resource.Adopted": {
      resourceId: "legacy-db",
      externalId: "arn:aws:rds:us-east-1:111111111111:db:legacy"
    },
    "exec.Started": {
      execId: "exec-assets-apply",
      resourceId: "assets",
      programHash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    },
    "exec.Output": {
      execId: "exec-assets-apply",
      stream: "stdout",
      line: "preview complete"
    },
    "exec.Succeeded": {
      execId: "exec-assets-apply",
      outputsHash: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    },
    "exec.Failed": {
      execId: "exec-assets-apply",
      reason: "preview failed"
    },
    "deployment.RolledBack": {
      deploymentId: "dep-gallery-prod",
      targetSetId: "set-prod-0001",
      reason: "canary SLO burn exceeded"
    },
    "deployment.Deployed": {
      deploymentId: "dep-gallery-prod",
      setId: "set-prod-0002",
      resourceIds: ["assets", "api"]
    }
  };

  if (!dataByType[type]) {
    throw new Error(`No fixture for ${type}`);
  }

  return createEvent(type, dataByType[type], overrides);
}

export function createGoldenDeploySequence() {
  const correlationId = "deploy-gallery-prod-001";
  const common = {
    tenant: "tenant-hobo",
    actor: { kind: "service", id: "yard/control-plane" },
    correlationId
  };
  const plan = fixturePlan();
  const planned = createPlannedEvent(plan, {
    ...common,
    id: "evt-001",
    seq: 1,
    causationId: "cmd-deploy-requested"
  });
  const match = createMatchDecidedEvent(fixtureMatchBody(), {
    ...common,
    id: "evt-002",
    seq: 2,
    causationId: planned.id
  });
  const sequence = [
    planned,
    match,
    createEvent("set.Created", {
      setId: "set-prod-0001",
      campId: "prod-aws",
      contentHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      sourcePlanHash: planned.data.planHash
    }, { ...common, id: "evt-003", seq: 3, causationId: match.id }),
    createEvent("delta.Opened", {
      deltaId: "delta-prod-0002",
      baseSetId: "set-prod-0001",
      author: "yard/planner"
    }, { ...common, id: "evt-004", seq: 4, causationId: "cmd-open-delta" }),
    createEvent("delta.Updated", {
      deltaId: "delta-prod-0002",
      operations: [{ op: "add", resourceId: "api" }]
    }, { ...common, id: "evt-005", seq: 5, causationId: "evt-004" }),
    createEvent("delta.Applied", {
      deltaId: "delta-prod-0002",
      resultingSetId: "set-prod-0002"
    }, { ...common, id: "evt-006", seq: 6, causationId: "evt-005" }),
    createEvent("resource.Pending", {
      resourceId: "assets",
      deps: []
    }, { ...common, id: "evt-007", seq: 7, causationId: "evt-006" }),
    createEvent("resource.Provisioning", {
      resourceId: "assets",
      provider: "aws",
      driver: "iac-pulumi"
    }, { ...common, id: "evt-008", seq: 8, causationId: "evt-007" }),
    createEvent("exec.Started", {
      execId: "exec-assets-apply",
      resourceId: "assets",
      programHash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    }, { ...common, id: "evt-009", seq: 9, causationId: "evt-008" }),
    createEvent("exec.Output", {
      execId: "exec-assets-apply",
      stream: "stdout",
      line: "preview complete"
    }, { ...common, id: "evt-010", seq: 10, causationId: "evt-009" }),
    createEvent("exec.Succeeded", {
      execId: "exec-assets-apply",
      outputsHash: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    }, { ...common, id: "evt-011", seq: 11, causationId: "evt-010" }),
    createEvent("resource.Provisioned", {
      resourceId: "assets",
      outputs: {
        bucketName: "gallery-prod-assets"
      }
    }, { ...common, id: "evt-012", seq: 12, causationId: "evt-011" }),
    createDispatchDecidedEvent(fixtureDispatchBody(), { ...common, id: "evt-013", seq: 13, causationId: "evt-006" }),
    createEvent("deployment.Deployed", {
      deploymentId: "dep-gallery-prod",
      setId: "set-prod-0002",
      resourceIds: ["assets", "api"]
    }, { ...common, id: "evt-014", seq: 14, causationId: "evt-012" })
  ];

  return sequence;
}

export function upcastEvent(event) {
  if (event.schemaVersion === CURRENT_SCHEMA_VERSION) {
    return clone(event);
  }

  if (event.type === "match.Decided" && event.schemaVersion === 0) {
    return {
      ...clone(event),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      data: {
        ...clone(event.data),
        tie: false
      }
    };
  }

  return clone(event);
}

export function validateControlPlaneEvent(event) {
  const errors = [];

  if (!event || !isJsonObject(event) || Array.isArray(event)) {
    return { ok: false, errors: ["event must be an object"] };
  }

  requireString(event, "id", errors);
  requireString(event, "type", errors);
  if (!CONTROL_PLANE_TYPE_SET.has(event.type)) {
    errors.push(`type ${event.type} is not a control-plane event`);
  }
  if (event.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${CURRENT_SCHEMA_VERSION}`);
  }
  if (!Number.isInteger(event.seq) || event.seq < 0) {
    errors.push("seq must be a non-negative integer");
  }
  requireString(event, "tenant", errors);
  requireString(event, "time", errors);
  requireString(event, "correlationId", errors);
  requireString(event, "causationId", errors);
  if (!event.actor || !isJsonObject(event.actor)) {
    errors.push("actor is required");
  } else {
    requireString(event.actor, "kind", errors, "actor.kind");
    requireString(event.actor, "id", errors, "actor.id");
  }
  if (!event.data || !isJsonObject(event.data) || Array.isArray(event.data)) {
    errors.push("data must be an object");
  }

  if (event.data && isJsonObject(event.data)) {
    validateRequiredBodyFields(event.type, event.data, errors);
    validateZodBody(event.type, event.data, errors);
    if (event.type === "deployment.Planned") {
      validatePlanned(event.data, errors);
    }
    if (event.type === "match.Decided") {
      validateMatchDecided(event.data, errors);
    }
    if (event.type === "dispatch.Decided") {
      validateDispatchDecided(event.data, errors);
    }
  }

  return { ok: errors.length === 0, errors };
}

function validateZodBody(type, data, errors) {
  const result = CONTROL_PLANE_BODY_ZOD_SCHEMAS[type]?.safeParse(data);
  if (!result) {
    return;
  }
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(`${type} ${issue.path.join(".") || "data"}: ${issue.message}`);
    }
  }
}

function fixturePlan() {
  return {
    deploymentId: "dep-gallery-prod",
    campId: "prod-aws",
    nodes: [
      { name: "assets", port: "wasi:blobstore/blobstore", provider: "aws", deps: [] },
      { name: "api", port: "hobo:runtime/workflow", provider: "aws", deps: ["assets"] }
    ],
    meta: {
      objective: "cost",
      matchDecisionIds: ["match-assets"]
    }
  };
}

function fixtureMatchBody() {
  return {
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
  };
}

function fixtureDispatchBody() {
  return {
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
      { provider: "github", effectiveMarginalCost: 0.04 },
      { provider: "depot", effectiveMarginalCost: 0 }
    ]
  };
}

function validateRequiredBodyFields(type, data, errors) {
  for (const field of REQUIRED_EVENT_BODY_FIELDS[type] ?? []) {
    if (data[field] === undefined || data[field] === null) {
      errors.push(`${type} ${field} is required`);
    }
  }
}

function createEvent(type, data, overrides = {}) {
  return {
    id: overrides.id ?? `evt-${stableDigest({ type, data }).slice(0, 12)}`,
    type,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    tenant: overrides.tenant ?? "tenant-hobo",
    seq: overrides.seq ?? 0,
    time: overrides.time ?? "2026-06-25T00:00:00.000Z",
    actor: overrides.actor ?? { kind: "service", id: "yard/control-plane" },
    correlationId: overrides.correlationId ?? "corr-control-plane-contract",
    causationId: overrides.causationId ?? "cmd-contract-fixture",
    data: clone(data)
  };
}

function validatePlanned(data, errors) {
  if (!data.plan || !isJsonObject(data.plan)) {
    errors.push("deployment.Planned plan is required");
    return;
  }
  requireString(data, "planHash", errors, "deployment.Planned planHash");
  if (data.planHash && data.planHash !== planContentAddress(data.plan)) {
    errors.push("deployment.Planned planHash must content-address the plan");
  }
}

function validateMatchDecided(data, errors) {
  requireString(data, "resourceId", errors, "match.Decided resourceId");
  requireString(data, "winner", errors, "match.Decided winner");
  if (!OBJECTIVES.has(data.objective)) {
    errors.push("match.Decided objective must be a supported objective");
  }
  if (!isJsonBoolean(data.tie)) {
    errors.push("match.Decided tie must be a boolean");
  }
  validateSha(data.catalogContentHash, "catalogContentHash", errors);
  if (!Array.isArray(data.ranking) || data.ranking.length === 0) {
    errors.push("match.Decided ranking must be a non-empty array");
  } else {
    data.ranking.forEach((entry, index) => {
      requireString(entry, "definitionId", errors, `ranking.${index}.definitionId`);
      if (entry.region !== undefined) requireString(entry, "region", errors, `ranking.${index}.region`);
      if (entry.rationale !== undefined) requireString(entry, "rationale", errors, `ranking.${index}.rationale`);
      for (const field of ["specificity", "priority", "objectiveScore", "rank"]) {
        if (!isJsonNumber(entry[field])) {
          errors.push(`ranking.${index}.${field} must be a number`);
        }
      }
    });
  }
  if (!Array.isArray(data.rejectedCandidates)) {
    errors.push("match.Decided rejectedCandidates must be an array");
  } else {
    data.rejectedCandidates.forEach((candidate, index) => {
      requireString(candidate, "definitionId", errors, `rejectedCandidates.${index}.definitionId`);
      requireString(candidate, "reason", errors, `rejectedCandidates.${index}.reason`);
    });
  }
}

function validateDispatchDecided(data, errors) {
  requireString(data, "dispatchId", errors, "dispatch.Decided dispatchId");
  requireString(data, "category", errors, "dispatch.Decided category");
  requireString(data, "selectedProvider", errors, "dispatch.Decided selectedProvider");
  if (!OBJECTIVES.has(data.objective)) {
    errors.push("dispatch.Decided objective must be a supported objective");
  }
  if (!data.ledgerInput || !isJsonObject(data.ledgerInput)) {
    errors.push("dispatch.Decided ledgerInput is required");
  } else {
    if (data.ledgerInput.view !== "CreditLedgerView") {
      errors.push("dispatch.Decided ledgerInput.view must be CreditLedgerView");
    }
    if (!Number.isInteger(data.ledgerInput.seq) || data.ledgerInput.seq < 0) {
      errors.push("dispatch.Decided ledgerInput.seq must be a non-negative integer");
    }
    requireString(data.ledgerInput, "reservationId", errors, "dispatch.Decided ledgerInput.reservationId");
    validateSha(data.ledgerInput.balanceHash, "ledgerInput.balanceHash", errors);
  }
  if (!Array.isArray(data.candidates) || data.candidates.length === 0) {
    errors.push("dispatch.Decided candidates must be a non-empty array");
  } else {
    data.candidates.forEach((candidate, index) => {
      requireString(candidate, "provider", errors, `candidates.${index}.provider`);
      if (!isJsonNumber(candidate.effectiveMarginalCost)) {
        errors.push(`candidates.${index}.effectiveMarginalCost must be a number`);
      }
      if (candidate.rationale !== undefined) {
        requireString(candidate, "rationale", errors, `candidates.${index}.rationale`);
      }
    });
  }
}

function validateSha(value, path, errors) {
  if (!isJsonString(value) || !SHA256_REF.test(value)) {
    errors.push(`${path} must be sha256`);
  }
}

function requireString(value, field, errors, label = field) {
  if (!isJsonString(value?.[field]) || value[field].length === 0) {
    errors.push(`${label} is required`);
  }
}

function sortForCanonicalJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortForCanonicalJson);
  }
  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortForCanonicalJson(nested)])
    );
  }
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
