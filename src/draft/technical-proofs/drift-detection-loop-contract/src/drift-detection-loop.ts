import { stableDigest } from "../../control-plane-event-schema-contract/src/control-plane-events.js";
import { isJsonString, isJsonObject } from "./json.js";


export const DRIFT_DETECTION_LOOP_VERSION = "hobo.drift-detection-loop/v1";

export function createDriftFixtureResource(overrides = {}) {
  const id = overrides.id ?? "db";
  const kind = overrides.kind ?? "managed";
  return {
    apiVersion: DRIFT_DETECTION_LOOP_VERSION,
    deploymentId: overrides.deploymentId ?? "deploy-gallery-prod",
    id,
    kind,
    name: overrides.name ?? id,
    desiredStateHash: overrides.desiredStateHash ?? "sha256:desired-v1",
    refreshIntervalMs: overrides.refreshIntervalMs ?? 60000,
    port: {
      interface: "hobo:resource/database",
      type: "database",
      className: "standard",
      ...overrides.port
    },
    provider: {
      id: "aws",
      definitionId: "aws-rds-standard",
      driver: "pulumi",
      ...overrides.provider
    },
    context: {
      tenant: "tenant-hobo",
      app: "gallery",
      env: "prod",
      resourceId: id,
      ...overrides.context
    }
  };
}

export function createDriftObservedState(overrides = {}) {
  return {
    lastResourceEvent: overrides.lastResourceEvent,
    outputs: clone(overrides.outputs ?? {}),
    providerStateHash: overrides.providerStateHash,
    nextSeq: overrides.nextSeq ?? 1,
    lease: overrides.lease ? clone(overrides.lease) : null,
    pendingDrift: overrides.pendingDrift ? clone(overrides.pendingDrift) : null,
    lastDriftFingerprint: overrides.lastDriftFingerprint,
    retryAfterMs: overrides.retryAfterMs
  };
}

export function createStubRefreshDriver({ reports = [], refresh } = {}) {
  const auditLog = [];
  let index = 0;
  return {
    auditLog,
    async refresh(input) {
      auditLog.push({
        type: "refresh",
        resourceId: input.resourcePlan.id,
        providerStateHash: input.observedState.providerStateHash
      });
      if (refresh) {
        return refresh(input);
      }
      const report = reports[Math.min(index, Math.max(reports.length - 1, 0))] ?? { status: "converged" };
      index += 1;
      return clone(report);
    }
  };
}

export async function runDriftResync({ resourcePlan, observedState = createDriftObservedState(), driver, reconciler }) {
  assertResourcePlan(resourcePlan);
  if (!driver?.refresh) {
    throw new Error("driver.refresh is required");
  }

  const state = createDriftObservedState(observedState);
  const report = normalizeRefreshReport(await driver.refresh({
    resourcePlan,
    observedState: clone(state)
  }));

  if (report.status === "failed") {
    const failure = {
      classification: report.classification ?? "retryable",
      reason: report.reason ?? "refresh failed"
    };
    state.retryAfterMs = report.retryAfterMs ?? 15000;
    const failed = event("resource.RefreshFailed", {
      resourceId: resourcePlan.id,
      classification: failure.classification,
      reason: failure.reason,
      retryAfterMs: state.retryAfterMs
    }, { resourcePlan, state, causationId: "driver-refresh" });
    state.lastResourceEvent = "resource.RefreshFailed";
    state.nextSeq += 1;
    return {
      status: "refresh-failed",
      events: [failed],
      reconcileRequested: false,
      failure,
      observedState: clone(state)
    };
  }

  if (report.status === "converged" || report.changes.length === 0) {
    state.providerStateHash = report.providerStateHash ?? state.providerStateHash;
    state.pendingDrift = null;
    if (state.providerStateHash === resourcePlan.desiredStateHash) {
      state.lastDriftFingerprint = undefined;
    }
    return {
      status: "converged",
      events: [],
      reconcileRequested: false,
      observedState: clone(state)
    };
  }

  const fingerprint = driftFingerprint(resourcePlan, report);
  const desiredStateHash = report.desiredStateHash ?? resourcePlan.desiredStateHash;
  if (state.lastDriftFingerprint === fingerprint && state.providerStateHash !== desiredStateHash) {
    const suppressed = event("resource.DriftSuppressed", {
      resourceId: resourcePlan.id,
      driftFingerprint: fingerprint,
      reason: "same drift fingerprint already reconciling or recently attempted"
    }, { resourcePlan, state, causationId: "driver-refresh" });
    state.nextSeq += 1;
    return {
      status: "flapping-drift-suppressed",
      events: [suppressed],
      reconcileRequested: false,
      observedState: clone(state)
    };
  }

  if (state.lease?.mode === "write") {
    state.pendingDrift = {
      driftFingerprint: fingerprint,
      reason: `single-writer lease held by ${state.lease.holder}`,
      report
    };
    const queued = event("resource.DriftQueued", {
      resourceId: resourcePlan.id,
      driftFingerprint: fingerprint,
      leaseHolder: state.lease.holder
    }, { resourcePlan, state, causationId: "driver-refresh" });
    state.nextSeq += 1;
    return {
      status: "serialized",
      events: [queued],
      reconcileRequested: false,
      observedState: clone(state)
    };
  }

  const driftDetected = event("resource.DriftDetected", {
    resourceId: resourcePlan.id,
    driftFingerprint: fingerprint,
    providerStateHash: report.providerStateHash,
    desiredStateHash,
    changes: clone(report.changes)
  }, { resourcePlan, state, causationId: "driver-refresh" });
  state.nextSeq += 1;
  state.lastResourceEvent = "resource.DriftDetected";
  state.lastDriftFingerprint = fingerprint;
  state.providerStateHash = report.providerStateHash ?? state.providerStateHash;

  if (isReadOnlyResource(resourcePlan)) {
    return {
      status: "drift-observed-readonly",
      events: [driftDetected],
      reconcileRequested: false,
      observedState: clone(state)
    };
  }

  if (!(reconciler instanceof Function)) {
    throw new Error("reconciler is required for drifted managed resources");
  }

  const updateRequested = event("resource.Updating", {
    resourceId: resourcePlan.id,
    previousVersion: report.providerStateHash ?? "unknown",
    targetVersion: desiredStateHash,
    driftFingerprint: fingerprint
  }, { resourcePlan, state, causationId: driftDetected.id });
  state.nextSeq += 1;

  const reconcile = await reconciler({
    resourcePlan,
    driftReport: clone(report),
    observedState: clone(state)
  });

  if (reconcile?.status !== "provisioned") {
    const failed = event("resource.Failed", {
      resourceId: resourcePlan.id,
      reason: reconcile?.reason ?? "drift reconcile failed"
    }, { resourcePlan, state, causationId: updateRequested.id });
    state.nextSeq += 1;
    state.lastResourceEvent = "resource.Failed";
    return {
      status: "reconcile-failed",
      events: [driftDetected, updateRequested, failed],
      reconcileRequested: true,
      observedState: clone(state)
    };
  }

  state.providerStateHash = reconcile.providerStateHash ?? desiredStateHash;
  state.outputs = clone(reconcile.outputs ?? state.outputs);
  state.lastResourceEvent = "resource.Provisioned";
  if (state.providerStateHash === desiredStateHash) {
    state.lastDriftFingerprint = undefined;
  }
  const provisioned = event("resource.Provisioned", {
    resourceId: resourcePlan.id,
    outputs: clone(state.outputs)
  }, { resourcePlan, state, causationId: updateRequested.id });
  state.nextSeq += 1;

  return {
    status: "reconverged",
    events: [driftDetected, updateRequested, provisioned],
    reconcileRequested: true,
    observedState: clone(state)
  };
}

function normalizeRefreshReport(report) {
  if (!report || !isJsonObject(report)) {
    throw new Error("refresh must return a DriftReport");
  }
  return {
    status: report.status ?? (report.changes?.length ? "drifted" : "converged"),
    providerStateHash: report.providerStateHash,
    desiredStateHash: report.desiredStateHash,
    changes: Array.isArray(report.changes) ? clone(report.changes) : [],
    classification: report.classification,
    reason: report.reason,
    retryAfterMs: report.retryAfterMs
  };
}

function driftFingerprint(resourcePlan, report) {
  return `sha256:${stableDigest({
    resourceId: resourcePlan.id,
    providerStateHash: report.providerStateHash,
    desiredStateHash: report.desiredStateHash ?? resourcePlan.desiredStateHash,
    changes: report.changes
  })}`;
}

function event(type, data, { resourcePlan, state, causationId }) {
  const eventBody = {
    type,
    schemaVersion: 1,
    tenant: resourcePlan.context.tenant,
    seq: state.nextSeq,
    time: "2026-06-27T00:00:00.000Z",
    actor: { kind: "service", id: `yard/resource-actor/${resourcePlan.id}` },
    correlationId: `corr-${resourcePlan.deploymentId}-${resourcePlan.id}-drift`,
    causationId,
    data: clone(data)
  };
  return {
    id: `evt-${stableDigest(eventBody).slice(0, 12)}`,
    ...eventBody
  };
}

function isReadOnlyResource(resourcePlan) {
  return resourcePlan.kind === "external" || resourcePlan.kind === "echo";
}

function assertResourcePlan(resourcePlan) {
  for (const field of ["id", "deploymentId", "desiredStateHash", "kind"]) {
    if (!isJsonString(resourcePlan?.[field]) || resourcePlan[field].length === 0) {
      throw new Error(`resourcePlan.${field} is required`);
    }
  }
  for (const field of ["id", "driver"]) {
    if (!isJsonString(resourcePlan.provider?.[field]) || resourcePlan.provider[field].length === 0) {
      throw new Error(`resourcePlan.provider.${field} is required`);
    }
  }
  if (!isJsonString(resourcePlan.context?.tenant) || resourcePlan.context.tenant.length === 0) {
    throw new Error("resourcePlan.context.tenant is required");
  }
}

function clone(value) {
  return structuredClone(value);
}
