import { createHash } from "node:crypto";
import {
  cloneAsJson,
  isJsonBoolean,
  isJsonObject,
  isJsonString,
  type JsonBag,
  type JsonValue,
} from "./json.js";

const HASH_PREFIX = "sha256:";
const REPLICATION_TOPOLOGIES = new Set([
  "single-writer-camp",
  "active-active-eventual",
  "pinned-single-camp",
]);

export interface EnvGroupMember {
  campId: string;
  provider: string;
  campIdOwner?: string;
  optional?: boolean;
}

export interface EnvGroup {
  id: string;
  environmentType: string;
  members: EnvGroupMember[];
}

export interface ResourceMatch {
  decisionId: string;
  definitionId: string;
  catalogHash: string;
}

export interface ResourceReplication {
  topology: string;
  campId?: string;
  ownerCampId?: string;
}

export interface WorkloadSpec {
  image: string;
}

export interface DeploymentResource {
  id: string;
  type: string;
  port: string;
  match?: ResourceMatch;
  replication?: ResourceReplication;
  workload?: WorkloadSpec;
}

export interface ResourceMap {
  [resourceId: string]: DeploymentResource;
}

export interface DeploymentSet {
  id: string;
  campId: string;
  environmentType: string;
  deploymentPlanId?: string | undefined;
  manifestDigest: string;
  previousSetId?: string | undefined;
  resources: ResourceMap;
  envGroup?: EnvGroup | undefined;
  contentAddress?: string;
}

export type DeltaOp = "add" | "update" | "remove";

export type DeltaChange =
  | { op: "add" | "update"; resourceId: string; resource: DeploymentResource }
  | { op: "remove"; resourceId: string };

export interface DeltaChangeInput {
  op: DeltaOp;
  resourceId: string;
  resource?: DeploymentResource | undefined;
}

export interface DeploymentDelta {
  id: string;
  baseSetId: string;
  campId: string;
  status: "open" | "applied";
  changes: DeltaChange[];
  appliedSetId?: string;
}

export interface DeploymentProjection {
  sets: Record<string, DeploymentSet>;
  currentSetsByCamp: Record<string, DeploymentSet>;
  deltas: Record<string, DeploymentDelta>;
}

interface SetCreatedBody {
  setId: string;
  campId: string;
  environmentType: string;
  deploymentPlanId?: string | undefined;
  manifestDigest: string;
  resources: ResourceMap;
  envGroup?: EnvGroup | undefined;
}

interface DeltaOpenedBody {
  deltaId: string;
  baseSetId: string;
  campId: string;
}

interface DeltaUpdatedBody {
  deltaId: string;
  changes: DeltaChangeInput[];
}

interface DeltaAppliedBody {
  deltaId: string;
  newSetId: string;
  deploymentPlanId?: string | undefined;
  manifestDigest?: string | undefined;
}

export type DeploymentProjectionEvent =
  | { seq: number; id?: string; type: "set.Created"; body: SetCreatedBody }
  | { seq: number; id?: string; type: "delta.Opened"; body: DeltaOpenedBody }
  | { seq: number; id?: string; type: "delta.Updated"; body: DeltaUpdatedBody }
  | { seq: number; id?: string; type: "delta.Applied"; body: DeltaAppliedBody };

export function foldDeploymentProjections(events: readonly DeploymentProjectionEvent[]): DeploymentProjection {
  const projection: DeploymentProjection = {
    sets: {},
    currentSetsByCamp: {},
    deltas: {},
  };
  const activeDeltasByCamp = new Map<string, string>();
  let lastSeq = -1;

  for (const event of events) {
    if (!Number.isInteger(event.seq) || event.seq <= lastSeq) {
      throw new Error(`out-of-order event stream at ${event.id ?? event.type}`);
    }
    lastSeq = event.seq;

    switch (event.type) {
      case "set.Created":
        recordCreatedSet(projection, event.body);
        break;
      case "delta.Opened":
        openDelta(projection, activeDeltasByCamp, event.body);
        break;
      case "delta.Updated":
        updateDelta(projection, event.body);
        break;
      case "delta.Applied":
        applyDelta(projection, activeDeltasByCamp, event.body);
        break;
      default:
        // SAFETY: `throw new Error(`unsupported deployment projection event: ${(event as { type: st` is required at this I/O or test boundary.
        throw new Error(`unsupported deployment projection event: ${(event as { type: string }).type}`);
    }
  }

  return projection;
}

export function contentAddressDeploymentSet(
  set: Pick<DeploymentSet, "campId" | "environmentType" | "envGroup" | "manifestDigest" | "resources">,
): string {
  const hashableSet = {
    campId: set.campId,
    environmentType: set.environmentType,
    envGroup: set.envGroup,
    manifestDigest: set.manifestDigest,
    resources: set.resources,
  };

  return `${HASH_PREFIX}${createHash("sha256").update(canonicalJson(hashableSet)).digest("hex")}`;
}

export function diffDeploymentSet(
  before: Pick<DeploymentSet, "resources">,
  after: Pick<DeploymentSet, "resources">,
): DeltaChange[] {
  const resourceIds = [...new Set([...Object.keys(before.resources), ...Object.keys(after.resources)])].sort();
  const changes: DeltaChange[] = [];

  for (const resourceId of resourceIds) {
    const beforeResource = before.resources[resourceId];
    const afterResource = after.resources[resourceId];

    if (!beforeResource && afterResource) {
      changes.push({ op: "add", resourceId, resource: clone(afterResource) });
      continue;
    }

    if (beforeResource && !afterResource) {
      changes.push({ op: "remove", resourceId });
      continue;
    }

    if (canonicalJson(beforeResource) !== canonicalJson(afterResource)) {
      changes.push({ op: "update", resourceId, resource: clone(afterResource!) });
    }
  }

  return changes;
}

export function validateEnvGroup(envGroup: JsonValue): EnvGroup {
  if (!isJsonObject(envGroup)) {
    throw new Error("env-group must be an object");
  }
  if (!isJsonString(envGroup.id) || !isJsonString(envGroup.environmentType)) {
    throw new Error("env-group requires id and environmentType");
  }
  if (!Array.isArray(envGroup.members) || envGroup.members.length === 0) {
    throw new Error("env-group requires one or more member Camps");
  }

  const campIds = new Set<string>();
  const members: EnvGroupMember[] = [];
  for (const entry of envGroup.members) {
    if (!isJsonObject(entry) || !isJsonString(entry.campId) || !isJsonString(entry.provider)) {
      throw new Error("env-group member requires campId and provider");
    }
    if (campIds.has(entry.campId)) {
      throw new Error(`duplicate Camp in env-group: ${entry.campId}`);
    }
    campIds.add(entry.campId);
    const optional = entry.optional;
    if (optional !== undefined && !isJsonBoolean(optional)) {
      throw new Error("env-group member optional must be a boolean");
    }
    const member: EnvGroupMember = {
      campId: entry.campId,
      provider: entry.provider,
    };
    if (optional !== undefined) member.optional = optional;
    members.push(member);
  }

  return clone({
    id: envGroup.id,
    environmentType: envGroup.environmentType,
    members,
  });
}

function recordCreatedSet(projection: DeploymentProjection, body: SetCreatedBody) {
  const deploymentSet = buildDeploymentSet({
    id: body.setId,
    campId: body.campId,
    environmentType: body.environmentType,
    deploymentPlanId: body.deploymentPlanId,
    manifestDigest: body.manifestDigest,
    resources: body.resources,
    envGroup: body.envGroup,
  });

  projection.sets[deploymentSet.id] = deploymentSet;
  projection.currentSetsByCamp[deploymentSet.campId] = deploymentSet;
}

function openDelta(projection: DeploymentProjection, activeDeltasByCamp: Map<string, string>, body: DeltaOpenedBody) {
  const baseSet = projection.sets[body.baseSetId];
  if (!baseSet) {
    throw new Error(`delta.Opened references unknown base Set: ${body.baseSetId}`);
  }
  if (baseSet.campId !== body.campId) {
    throw new Error(`delta.Opened Camp ${body.campId} does not match base Set Camp ${baseSet.campId}`);
  }
  if (projection.currentSetsByCamp[body.campId]?.id !== body.baseSetId) {
    throw new Error(`delta.Opened must target the current Set for Camp ${body.campId}`);
  }

  if (activeDeltasByCamp.has(body.campId)) {
    throw new Error(`overlapping open Delta for Camp ${body.campId}`);
  }

  projection.deltas[body.deltaId] = {
    id: body.deltaId,
    baseSetId: body.baseSetId,
    campId: body.campId,
    status: "open",
    changes: [],
  };
  activeDeltasByCamp.set(body.campId, body.deltaId);
}

function updateDelta(projection: DeploymentProjection, body: DeltaUpdatedBody) {
  const delta = projection.deltas[body.deltaId];
  if (!delta) {
    throw new Error(`delta.Updated before delta.Opened: ${body.deltaId}`);
  }
  if (delta.status !== "open") {
    throw new Error(`delta.Updated cannot modify ${delta.status} Delta: ${body.deltaId}`);
  }
  const baseSet = projection.sets[delta.baseSetId]!;
  const nextChanges = [...delta.changes, ...body.changes.map(normalizeChange)];

  applyChanges(baseSet.resources, nextChanges);
  delta.changes = nextChanges;
}

function applyDelta(projection: DeploymentProjection, activeDeltasByCamp: Map<string, string>, body: DeltaAppliedBody) {
  const delta = projection.deltas[body.deltaId];
  if (!delta) {
    throw new Error(`delta.Applied before delta.Opened: ${body.deltaId}`);
  }
  if (delta.status !== "open") {
    throw new Error(`delta.Applied cannot re-apply ${delta.status} Delta: ${body.deltaId}`);
  }

  const baseSet = projection.sets[delta.baseSetId]!;
  const resources = applyChanges(baseSet.resources, delta.changes);
  const deploymentSet = buildDeploymentSet({
    id: body.newSetId,
    previousSetId: baseSet.id,
    campId: baseSet.campId,
    environmentType: baseSet.environmentType,
    deploymentPlanId: body.deploymentPlanId ?? baseSet.deploymentPlanId,
    manifestDigest: body.manifestDigest ?? baseSet.manifestDigest,
    resources,
    envGroup: baseSet.envGroup,
  });

  projection.sets[deploymentSet.id] = deploymentSet;
  projection.currentSetsByCamp[deploymentSet.campId] = deploymentSet;
  delta.status = "applied";
  delta.appliedSetId = deploymentSet.id;
  activeDeltasByCamp.delete(delta.campId);
}

interface DeploymentSetInput {
  id: string;
  campId: string;
  environmentType: string;
  deploymentPlanId?: string | undefined;
  manifestDigest: string;
  previousSetId?: string | undefined;
  resources: ResourceMap;
  envGroup?: EnvGroup | undefined;
}

function buildDeploymentSet(input: DeploymentSetInput): DeploymentSet {
  if (!input.id || !input.campId || !input.environmentType || !input.manifestDigest) {
    throw new Error("DeploymentSet requires id, campId, environmentType, and manifestDigest");
  }

  const deploymentSet: DeploymentSet = {
    id: input.id,
    campId: input.campId,
    environmentType: input.environmentType,
    deploymentPlanId: input.deploymentPlanId,
    manifestDigest: input.manifestDigest,
    previousSetId: input.previousSetId,
    resources: validateResources(input.resources),
    envGroup: input.envGroup ? validateEnvGroup(cloneAsJson(input.envGroup)) : undefined,
  };
  deploymentSet.contentAddress = contentAddressDeploymentSet(deploymentSet);

  // SAFETY: `return JSON.parse(canonicalJson(deploymentSet)) as DeploymentSet;` is required at this I/O or test boundary.
  return JSON.parse(canonicalJson(deploymentSet)) as DeploymentSet;
}

function applyChanges(baseResources: ResourceMap, changes: readonly DeltaChange[]): ResourceMap {
  const resources = clone(baseResources);

  for (const change of changes.map(normalizeChange)) {
    switch (change.op) {
      case "add":
        if (resources[change.resourceId]) {
          throw new Error(`Delta add references existing resource: ${change.resourceId}`);
        }
        resources[change.resourceId] = validateResource(change.resourceId, change.resource);
        break;
      case "update":
        if (!resources[change.resourceId]) {
          throw new Error(`Delta update references absent resource: ${change.resourceId}`);
        }
        resources[change.resourceId] = validateResource(change.resourceId, change.resource);
        break;
      case "remove":
        if (!resources[change.resourceId]) {
          throw new Error(`Delta remove references absent resource: ${change.resourceId}`);
        }
        delete resources[change.resourceId];
        break;
      default:
        // SAFETY: `throw new Error(`unsupported Delta operation: ${(change as DeltaChangeInput).op}` is required at this I/O or test boundary.
        throw new Error(`unsupported Delta operation: ${(change as DeltaChangeInput).op}`);
    }
  }

  return resources;
}

function validateResources(resources: ResourceMap): ResourceMap {
  if (!isJsonObject(resources) || Array.isArray(resources)) {
    throw new Error("DeploymentSet resources must be a resource map");
  }

  const validated: ResourceMap = {};
  for (const resourceId of Object.keys(resources).sort()) {
    validated[resourceId] = validateResource(resourceId, resources[resourceId]!);
  }

  return validated;
}

function validateResource(resourceId: string, resource: DeploymentResource): DeploymentResource {
  if (!isJsonObject(resource)) {
    throw new Error(`resource ${resourceId} must be an object`);
  }
  if (resource.id !== resourceId) {
    throw new Error(`resource id mismatch for ${resourceId}`);
  }
  if (!resource.type || !resource.port) {
    throw new Error(`resource ${resourceId} requires type and port`);
  }
  if (!resource.match?.decisionId || !resource.match?.definitionId || !resource.match?.catalogHash) {
    throw new Error(`resource ${resourceId} requires resolved match decision metadata`);
  }
  if (!resource.replication || !REPLICATION_TOPOLOGIES.has(resource.replication.topology)) {
    throw new Error(`resource ${resourceId} requires a valid replication topology`);
  }

  return clone(resource);
}

function normalizeChange(change: DeltaChangeInput): DeltaChange {
  if (!isJsonObject(change)) {
    throw new Error("Delta change must be an object");
  }
  if (!change.op || !change.resourceId) {
    throw new Error("Delta change requires op and resourceId");
  }
  if ((change.op === "add" || change.op === "update") && !change.resource) {
    throw new Error(`Delta ${change.op} requires resource: ${change.resourceId}`);
  }

  return change.op === "remove"
    ? { op: change.op, resourceId: change.resourceId }
    : { op: change.op, resourceId: change.resourceId, resource: clone(change.resource!) };
}

function canonicalJson<T>(value: T): string {
  return JSON.stringify(canonicalize(cloneAsJson(value)));
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!isJsonObject(value)) {
    return value;
  }

  const canonical: JsonBag = {};
  for (const key of Object.keys(value).sort()) {
    const nested = value[key];
    if (nested !== undefined) {
      canonical[key] = canonicalize(nested);
    }
  }
  return canonical;
}

function clone<T>(value: T): T {
  // SAFETY: `return JSON.parse(JSON.stringify(value)) as T;` is required at this I/O or test boundary.
  return JSON.parse(JSON.stringify(value)) as T;
}
