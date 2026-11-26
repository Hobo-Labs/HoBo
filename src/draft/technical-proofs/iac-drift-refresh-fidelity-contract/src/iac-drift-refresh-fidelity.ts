import { isJsonObject } from "./json.js";
const REFRESH_FIDELITY_CHECK_ID = "iac-drift.camp.refresh-fidelity";

export function createDriftFidelityFixture() {
  const desired = {
    resources: {
      api: {
        id: "api",
        kind: "managed",
        stackKey: "tenant-a/prod/api",
        spec: {
          image: "api:v1",
          replicas: 2,
          serverDefaultedSku: "standard",
        },
        provider: { backend: "iac-pulumi", provider: "aws" },
        observed: {
          urn: "urn:pulumi:api",
          revision: "provider-revision-0",
        },
        normalizedPaths: ["observed.revision", "spec.serverDefaultedSku"],
      },
      "api-log-group": {
        id: "api-log-group",
        parentId: "api",
        kind: "managed",
        stackKey: "tenant-a/prod/api-log-group",
        spec: { retentionDays: 7 },
        provider: { backend: "iac-pulumi", provider: "aws" },
        observed: { urn: "urn:pulumi:api-log-group" },
      },
      worker: {
        id: "worker",
        kind: "managed",
        stackKey: "tenant-a/prod/worker",
        spec: { image: "worker:v1", replicas: 1 },
        provider: { backend: "iac-opentofu", provider: "aws" },
        observed: { urn: "urn:tofu:worker" },
      },
      "legacy-db": {
        id: "legacy-db",
        kind: "adopted",
        stackKey: "tenant-a/prod/legacy-db",
        spec: { endpoint: "postgres://legacy.internal:5432/shop" },
        provider: { backend: "iac-pulumi", provider: "aws" },
        observed: { urn: "urn:pulumi:legacy-db" },
      },
    },
  };

  return {
    stackKey: "tenant-a/prod/api",
    desired,
    observed: structuredClone(desired),
  };
}

export function evaluateRefreshReport({ desired, observed }) {
  const desiredResources = desired.resources ;
  const observedResources = observed.resources ;
  const resourceIds = [...new Set([...Object.keys(desiredResources), ...Object.keys(observedResources)])].sort();
  const resources = [];
  const ignoredNormalized = [];

  for (const resourceId of resourceIds) {
    const desiredResource = desiredResources[resourceId];
    const observedResource = observedResources[resourceId];

    if (!desiredResource) {
      resources.push({
        resourceId,
        kind: observedResource.kind ?? "managed",
        stackKey: observedResource.stackKey,
        mode: "managed",
        action: "delete-extra",
        reasons: ["extra-in-reality"],
        changes: [
          {
            path: "resource",
            desired: "absent",
            observed: "present",
            reason: "extra-in-reality",
          },
        ],
      });
      continue;
    }

    if (!observedResource) {
      resources.push(formatResourceDrift(desiredResource, [
        {
          path: "resource",
          desired: "present",
          observed: "missing",
          reason: "missing-in-reality",
        },
      ]));
      continue;
    }

    const changes = diffResource(desiredResource, observedResource, ignoredNormalized);
    if (changes.length > 0) {
      resources.push(formatResourceDrift(desiredResource, changes));
    }
  }

  return {
    drifted: resources.length > 0,
    resources,
    ignoredNormalized: ignoredNormalized.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export function reconcileDriftReport({ desired, observed, report }) {
  const nextObserved = structuredClone(observed);
  const actions = [];

  for (const resource of report.resources ?? []) {
    if (resource.action === "record-drift") {
      actions.push({
        action: "record-drift",
        resourceId: resource.resourceId,
        mode: "detect-only",
      });
      continue;
    }

    if (resource.action === "delete-extra") {
      delete nextObserved.resources[resource.resourceId];
      actions.push({
        action: `delete-extra:${resource.resourceId}`,
        resourceId: resource.resourceId,
      });
      continue;
    }

    if (resource.action === "update" || resource.action === "recreate") {
      nextObserved.resources[resource.resourceId] = structuredClone(desired.resources[resource.resourceId]);
      actions.push({
        action: `${resource.action}:${resource.resourceId}`,
        resourceId: resource.resourceId,
      });
    }
  }

  return { observed: nextObserved, actions };
}

export function createRefreshProvider({ fixture, observed, reports } = {}) {
  let reportIndex = 0;
  return {
    async refresh() {
      if (reports) {
        const report = reports[Math.min(reportIndex, reports.length - 1)];
        reportIndex += 1;
        return structuredClone(report);
      }

      return evaluateRefreshReport({
        ...fixture,
        observed,
      });
    },
  };
}

export async function runRefreshFidelityConformance(provider, { fixture, observed, attempts = 3 }) {
  const expectedReport = evaluateRefreshReport({ ...fixture, observed });
  const expectedDriftIds = expectedReport.resources.map((resource) => resource.resourceId).sort();
  const checks = [
    {
      id: REFRESH_FIDELITY_CHECK_ID,
      tag: "camp",
    },
  ];
  const failures = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const report = await provider.refresh();
    const actualDriftIds = (report.resources ?? []).map((resource) => resource.resourceId).sort();
    const missing = expectedDriftIds.filter((resourceId) => !actualDriftIds.includes(resourceId));

    if (missing.length > 0) {
      failures.push({
        code: "refresh-intermittent-miss",
        attempt,
        message: `refresh() missed drift for ${missing.join(", ")}`,
      });
      break;
    }

    const unexpected = actualDriftIds.filter((resourceId) => !expectedDriftIds.includes(resourceId));
    if (unexpected.length > 0) {
      failures.push({
        code: "refresh-unexpected-drift",
        attempt,
        message: `refresh() reported unexpected drift for ${unexpected.join(", ")}`,
      });
      break;
    }
  }

  return failures.length === 0
    ? { status: "pass", checks }
    : { status: "fail", checks, failures };
}

function diffResource(desiredResource, observedResource, ignoredNormalized) {
  const normalizedPaths = new Set(desiredResource.normalizedPaths ?? []);
  return [
    ...diffObject("spec", desiredResource.spec , observedResource.spec , desiredResource.id, normalizedPaths, ignoredNormalized),
    ...diffObject("observed", desiredResource.observed , observedResource.observed , desiredResource.id, normalizedPaths, ignoredNormalized),
  ];
}

function diffObject(prefix, desiredValue, observedValue, resourceId, normalizedPaths, ignoredNormalized) {
  const changes = [];
  const keys = [...new Set([...Object.keys(desiredValue), ...Object.keys(observedValue)])].sort();

  for (const key of keys) {
    const path = `${prefix}.${key}`;
    const desired = desiredValue[key];
    const observed = observedValue[key];

    if (normalizedPaths.has(path)) {
      if (!isDeepEqual(desired, observed)) {
        ignoredNormalized.push({
          resourceId,
          path: `${resourceId}.${path}`,
          desired,
          observed,
          reason: "provider-normalized",
        });
      }
      continue;
    }

    if (isPlainObject(desired) && isPlainObject(observed)) {
      changes.push(...diffObject(path, desired, observed, resourceId, normalizedPaths, ignoredNormalized));
      continue;
    }

    if (!isDeepEqual(desired, observed)) {
      changes.push({
        path,
        desired,
        observed,
        reason: "spec-drift",
      });
    }
  }

  return changes;
}

function formatResourceDrift(desiredResource, changes) {
  const reasons = [...new Set(changes.map((change) => change.reason))];
  const action = selectAction(desiredResource, reasons);
  const drift = {
    resourceId: desiredResource.id,
    kind: desiredResource.kind,
    stackKey: desiredResource.stackKey,
    mode: desiredResource.kind === "adopted" ? "detect-only" : "managed",
    action,
    reasons,
    changes,
  };

  if (desiredResource.parentId) {
    drift.parentId = desiredResource.parentId;
  }

  return drift;
}

function selectAction(resource, reasons) {
  if (resource.kind === "adopted") {
    return "record-drift";
  }

  return reasons.includes("missing-in-reality") ? "recreate" : "update";
}

function isPlainObject(value) {
  return isJsonObject(value) && value !== null && !Array.isArray(value);
}

function isDeepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
