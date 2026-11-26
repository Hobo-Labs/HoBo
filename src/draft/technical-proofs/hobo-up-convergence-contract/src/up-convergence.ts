/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: these checks parse erased provider results at the convergence boundary. */
import { createHash, randomUUID } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const HOBO_UP_CONVERGENCE_VERSION = "hobo.up-convergence/v1";

export class HoboUpError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "HoboUpError";
    this.code = code;
    this.details = details;
  }
}

export function createHoboUpConvergence({
  now = () => new Date().toISOString(),
  idFactory = (prefix) => `${prefix}-${randomUUID()}`,
  collectResources = defaultCollectResources,
  planDeployment = defaultPlanDeployment,
  evaluateGate = defaultEvaluateGate,
  applySet = defaultApplySet,
  deployRevision = defaultDeployRevision,
} = {}) {
  return {
    async run({
      project = sampleSnapshopProject(),
      flags = {},
      eventLog = [],
      appendEvent,
      streamEvent,
    } = {}) {
      const normalizedFlags = normalizeFlags(flags);
      assertRevisionSelector(normalizedFlags);

      const campId = normalizedFlags.camp ?? project.defaultCampId ?? "dev";
      const deploymentId = project.deploymentId ?? `deployment:${project.name ?? "app"}`;
      const correlationId = `up:${deploymentId}:${campId}:${idFactory("run")}`;
      const events = [];
      const combinedLog = [...eventLog];
      let lastEventId = combinedLog.at(-1)?.id ?? `command:up:${deploymentId}:${campId}`;
      let nextSeq = nextSequence(combinedLog);

      const emit = async (type, data = {}) => {
        const event = makeUpEvent({
          id: idFactory("up-event"),
          type,
          seq: nextSeq,
          time: now(),
          deploymentId,
          campId,
          correlationId,
          causationId: lastEventId,
          data,
        });
        nextSeq += 1;

        const appendResult = appendEvent ? await appendEvent(event) : { appended: true };
        if (appendResult?.appended === false) {
          throw new HoboUpError(
            `Could not append ${type}: ${appendResult.reason ?? "append rejected"}`,
            "append-rejected",
            { eventType: type, reason: appendResult.reason },
          );
        }

        events.push(event);
        combinedLog.push(event);
        lastEventId = event.id;
        if (streamEvent) {
          await streamEvent(event);
        }
        return event;
      };

      await emit("deployment.UpStarted", {
        campId,
        strategy: normalizedFlags.strategy,
        revisionSelector: publicRevisionSelector(normalizedFlags),
      });

      const revision = selectRevision({ flags: normalizedFlags, eventLog: combinedLog, campId, project });
      await emit("deployment.RevisionSelected", revision);

      const manifest = await collectResources(clone(project), {
        campId,
        revision: revision.revision,
        flags: clone(normalizedFlags),
      });
      const normalizedManifest = normalizeManifest(manifest);
      await emit("bindle.ManifestProduced", {
        manifestDigest: normalizedManifest.digest,
        resourceIds: normalizedManifest.resources.map((resource) => resource.id),
      });

      const desiredSet = normalizeDeploymentSet(
        await planDeployment({
          project: clone(project),
          manifest: clone(normalizedManifest),
          campId,
          strategy: normalizedFlags.strategy,
          revision,
        }),
      );
      await emit("deployment.Planned", {
        setId: desiredSet.id,
        targetKey: desiredSet.targetKey,
        manifestDigest: desiredSet.manifestDigest,
        strategy: desiredSet.strategy,
      });

      const gate = normalizeGateResult(
        await evaluateGate({
          project: clone(project),
          manifest: clone(normalizedManifest),
          set: clone(desiredSet),
          campId,
          flags: clone(normalizedFlags),
          revision,
        }),
      );

      if (gate.status !== "passed") {
        await emit("deployment.PlanRejected", {
          code: gate.code,
          reason: gate.reason,
          fix: gate.fix,
          setId: desiredSet.id,
          targetKey: desiredSet.targetKey,
          provisionedResourceIds: [],
        });
        return result("blocked", {
          campId,
          revision: revision.revision,
          liveUrl: null,
          events,
          reason: gate.reason,
          fix: gate.fix,
          applied: false,
        });
      }

      await emit("gate.DeployPassed", {
        gateId: gate.gateId,
        setId: desiredSet.id,
      });

      const completed = findCompleted(combinedLog, campId, desiredSet.targetKey);
      if (completed) {
        await emit("deployment.UpNoop", {
          setId: desiredSet.id,
          targetKey: desiredSet.targetKey,
          liveUrl: completed.data.liveUrl,
          revision: completed.data.revision,
        });
        return result("noop", {
          campId,
          revision: completed.data.revision,
          liveUrl: completed.data.liveUrl,
          events,
          applied: false,
        });
      }

      const applied = findAppliedSet(combinedLog, campId, desiredSet.targetKey);
      if (applied) {
        await emit("deployment.SetReused", {
          setId: desiredSet.id,
          targetKey: desiredSet.targetKey,
          reason: "resume-after-interruption",
        });
      } else {
        try {
          const applyResult = await applySet(clone(desiredSet), {
            project: clone(project),
            campId,
            correlationId,
          });
          const appliedResources = normalizeAppliedResources(applyResult, desiredSet);
          for (const resource of appliedResources) {
            await emit("resource.Provisioned", {
              resourceId: resource.resourceId,
              providerId: resource.providerId,
              endpoint: resource.endpoint,
            });
          }
          await emit("deployment.SetApplied", {
            setId: desiredSet.id,
            targetKey: desiredSet.targetKey,
            resourceIds: appliedResources.map((resource) => resource.resourceId),
          });
        } catch (error) {
          await emit("deployment.UpInterrupted", {
            stage: "apply",
            setId: desiredSet.id,
            message: errorMessage(error),
            desiredStateCommitted: false,
          });
          return result("interrupted", {
            campId,
            revision: revision.revision,
            liveUrl: null,
            events,
            reason: errorMessage(error),
            applied: false,
          });
        }
      }

      try {
        const deployed = await deployRevision(clone(desiredSet), {
          project: clone(project),
          campId,
          revision,
          strategy: normalizedFlags.strategy,
        });
        const liveUrl = requireString(deployed?.liveUrl, "deploy result liveUrl");
        await emit("deployment.Deployed", {
          setId: desiredSet.id,
          targetKey: desiredSet.targetKey,
          revision: revision.revision,
          liveUrl,
        });
        await emit("deployment.UpCompleted", {
          setId: desiredSet.id,
          targetKey: desiredSet.targetKey,
          manifestDigest: desiredSet.manifestDigest,
          strategy: desiredSet.strategy,
          revision: revision.revision,
          liveUrl,
        });
        return result("deployed", {
          campId,
          revision: revision.revision,
          liveUrl,
          events,
          applied: true,
        });
      } catch (error) {
        await emit("deployment.UpInterrupted", {
          stage: "deploy",
          setId: desiredSet.id,
          message: errorMessage(error),
          desiredStateCommitted: false,
        });
        return result("interrupted", {
          campId,
          revision: revision.revision,
          liveUrl: null,
          events,
          reason: errorMessage(error),
          applied: true,
        });
      }
    },
  };
}

export async function runHoboUp(input = {}, options = {}) {
  return createHoboUpConvergence(options).run(input);
}

export function sampleSnapshopProject(overrides = {}) {
  return {
    name: "snapshop",
    deploymentId: "dep-snapshop",
    defaultCampId: "dev",
    currentRevision: "rev-working-tree",
    resources: [
      { id: "catalog", type: "kv", deps: [] },
      { id: "images", type: "bucket", deps: [] },
      { id: "api", type: "service", deps: ["catalog", "images"] },
    ],
    ...overrides,
  };
}

export function makeUpEvent({
  id,
  type,
  seq,
  time,
  deploymentId,
  campId,
  correlationId,
  causationId,
  data = {},
}) {
  for (const [field, value] of Object.entries({ id, type, seq, time, deploymentId, campId, correlationId, causationId })) {
    if (value === undefined || value === null || value === "") {
      throw new HoboUpError(`Missing required up event field: ${field}`, "missing-field", { field });
    }
  }
  return {
    apiVersion: HOBO_UP_CONVERGENCE_VERSION,
    id,
    type,
    seq,
    time,
    deploymentId,
    campId,
    correlationId,
    causationId,
    data: clone(data),
  };
}

function normalizeFlags(flags) {
  return {
    camp: flags.camp ?? null,
    strategy: flags.strategy ?? "recreate",
    to: flags.to ?? null,
    rollback: Boolean(flags.rollback),
    json: Boolean(flags.json),
  };
}

function assertRevisionSelector(flags) {
  if (flags.to && flags.rollback) {
    throw new HoboUpError(
      '--to cannot be combined with --rollback. Use one revision selector for "hobo up".',
      "conflicting-revision-selector",
      { to: flags.to, rollback: flags.rollback },
    );
  }
}

function publicRevisionSelector(flags) {
  if (flags.to) {
    return { kind: "explicit", revision: flags.to };
  }
  if (flags.rollback) {
    return { kind: "rollback" };
  }
  return { kind: "current" };
}

function selectRevision({ flags, eventLog, campId, project }) {
  if (flags.to) {
    return { kind: "explicit", revision: flags.to };
  }

  if (flags.rollback) {
    const lastGood = [...eventLog]
      .reverse()
      .find((event) => event.campId === campId && event.type === "deployment.UpCompleted");
    if (!lastGood?.data?.revision) {
      throw new HoboUpError(`No last-good revision recorded for Camp "${campId}".`, "missing-last-good", {
        campId,
      });
    }
    return { kind: "rollback", revision: lastGood.data.revision };
  }

  return { kind: "current", revision: project.currentRevision ?? "rev-current" };
}

function defaultCollectResources(project, { revision }) {
  const resources = (project.resources ?? []).map((resource) => ({
    id: requireString(resource.id, "resource id"),
    type: requireString(resource.type, `resource ${resource.id} type`),
    deps: [...(resource.deps ?? [])],
  }));
  return {
    schema: "hobo.manifest/v1",
    revision,
    resources,
  };
}

function defaultPlanDeployment({ project, manifest, campId, strategy, revision }) {
  const manifestDigest = manifest.digest;
  const targetKey = `${campId}:${strategy}:${revision.revision}:${manifestDigest}`;
  return {
    id: `set-${digest(targetKey).slice(0, 12)}`,
    campId,
    strategy,
    revision: revision.revision,
    targetKey,
    manifestDigest,
    resources: manifest.resources.map((resource) => ({
      ...resource,
      providerId: campId === "dev" ? "runtime-local" : "yard-provider",
      endpoint: campId === "dev" && resource.type === "service" ? `http://localhost:4100/${project.name}` : null,
    })),
  };
}

function defaultEvaluateGate() {
  return { status: "passed", gateId: "gate-default" };
}

function defaultApplySet(set) {
  return {
    resources: set.resources.map((resource) => ({
      resourceId: resource.id,
      providerId: resource.providerId ?? "runtime-local",
      endpoint: resource.endpoint ?? null,
    })),
  };
}

function defaultDeployRevision(set, { project, campId, revision }) {
  const liveUrl = campId === "dev"
    ? `http://localhost:4100/${project.name}`
    : `https://${project.name}.${campId}.hobo.example`;
  return {
    revision: revision.revision,
    liveUrl,
  };
}

function normalizeManifest(manifest) {
  if (!manifest || !isJsonObject(manifest)) {
    throw new HoboUpError("collectResources must return a manifest object", "invalid-manifest");
  }
  if (manifest.schema !== "hobo.manifest/v1") {
    throw new HoboUpError("manifest schema must be hobo.manifest/v1", "invalid-manifest-schema", {
      schema: manifest.schema,
    });
  }
  if (!Array.isArray(manifest.resources) || manifest.resources.length === 0) {
    throw new HoboUpError("manifest must contain at least one resource", "empty-manifest");
  }
  const resources = manifest.resources.map((resource) => ({
    id: requireString(resource.id, "manifest resource id"),
    type: requireString(resource.type, `manifest resource ${resource.id} type`),
    deps: [...(resource.deps ?? [])],
  }));
  assertResourceDeps(resources);
  const normalized = { schema: manifest.schema, resources };
  return {
    ...normalized,
    digest: manifest.digest ?? `sha256:${digest(canonicalJson(normalized))}`,
  };
}

function normalizeDeploymentSet(set) {
  if (!set || !isJsonObject(set)) {
    throw new HoboUpError("planDeployment must return a DeploymentSet", "invalid-set");
  }
  const normalized = {
    id: requireString(set.id, "DeploymentSet id"),
    campId: requireString(set.campId, "DeploymentSet campId"),
    strategy: requireString(set.strategy, "DeploymentSet strategy"),
    revision: requireString(set.revision, "DeploymentSet revision"),
    targetKey: requireString(set.targetKey, "DeploymentSet targetKey"),
    manifestDigest: requireString(set.manifestDigest, "DeploymentSet manifestDigest"),
    resources: (set.resources ?? []).map((resource) => ({
      id: requireString(resource.id, "DeploymentSet resource id"),
      type: requireString(resource.type, `DeploymentSet resource ${resource.id} type`),
      deps: [...(resource.deps ?? [])],
      providerId: resource.providerId ?? null,
      endpoint: resource.endpoint ?? null,
    })),
  };
  assertResourceDeps(normalized.resources);
  return normalized;
}

function normalizeGateResult(gate) {
  if (!gate || !isJsonObject(gate)) {
    throw new HoboUpError("evaluateGate must return a gate result", "invalid-gate");
  }
  if (gate.status === "passed") {
    return { status: "passed", gateId: gate.gateId ?? "gate" };
  }
  return {
    status: "failed",
    code: gate.code ?? "gate.failed",
    reason: requireString(gate.reason, "gate failure reason"),
    fix: gate.fix ?? "fix the failing gate and rerun hobo up",
  };
}

function normalizeAppliedResources(applyResult, set) {
  const resources = applyResult?.resources ?? set.resources.map((resource) => ({
    resourceId: resource.id,
    providerId: resource.providerId,
    endpoint: resource.endpoint,
  }));
  if (!Array.isArray(resources)) {
    throw new HoboUpError("applySet result resources must be an array", "invalid-apply-result");
  }
  return resources.map((resource) => ({
    resourceId: requireString(resource.resourceId, "applied resource id"),
    providerId: resource.providerId ?? null,
    endpoint: resource.endpoint ?? null,
  }));
}

function findCompleted(events, campId, targetKey) {
  const latestCompleted = [...events]
    .reverse()
    .find((event) => event.campId === campId && event.type === "deployment.UpCompleted");
  return latestCompleted?.data?.targetKey === targetKey ? latestCompleted : null;
}

function findAppliedSet(events, campId, targetKey) {
  return [...events]
    .reverse()
    .find((event) => event.campId === campId && event.type === "deployment.SetApplied" && event.data?.targetKey === targetKey);
}

function assertResourceDeps(resources) {
  const ids = new Set(resources.map((resource) => resource.id));
  for (const resource of resources) {
    for (const dep of resource.deps) {
      if (!ids.has(dep)) {
        throw new HoboUpError(`resource ${resource.id} has missing dependency ${dep}`, "missing-resource-dependency", {
          resourceId: resource.id,
          dependencyId: dep,
        });
      }
    }
  }
}

function result(status, { campId, revision, liveUrl, events, reason = null, fix = null, applied }) {
  return {
    ok: status === "deployed" || status === "noop",
    status,
    campId,
    revision,
    liveUrl,
    events,
    reason,
    fix,
    applied,
    json: {
      status,
      campId,
      revision,
      liveUrl,
      reason,
      fix,
      events: events.map((event) => ({
        type: event.type,
        resourceId: event.data.resourceId ?? null,
        setId: event.data.setId ?? null,
      })),
    },
  };
}

function nextSequence(events) {
  return events.reduce((max, event) => Math.max(max, event.seq ?? 0), 0) + 1;
}

function requireString(value, label) {
  if (!isJsonString(value) || value.trim().length === 0) {
    throw new HoboUpError(`${label} is required`, "missing-field", { label });
  }
  return value;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "unknown up failure";
}

function digest(input) {
  return createHash("sha256").update(input).digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone(value);
}
