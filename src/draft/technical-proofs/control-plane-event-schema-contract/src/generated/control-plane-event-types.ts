export const GENERATED_CONTROL_PLANE_EVENT_TYPES = [
  "deployment.Planned",
  "deployment.PlanRejected",
  "match.Decided",
  "set.Created",
  "delta.Opened",
  "delta.Updated",
  "delta.Applied",
  "resource.Pending",
  "resource.Provisioning",
  "resource.Provisioned",
  "resource.DriftDetected",
  "resource.DriftQueued",
  "resource.Updating",
  "resource.RefreshFailed",
  "resource.DriftSuppressed",
  "resource.Failed",
  "resource.Destroying",
  "resource.Destroyed",
  "resource.Adopted",
  "exec.Started",
  "exec.Output",
  "exec.Succeeded",
  "exec.Failed",
  "dispatch.Decided",
  "deployment.RolledBack",
  "deployment.Deployed"
];

export const GENERATED_REQUIRED_EVENT_BODY_FIELDS = {
  "deployment.Planned": [
    "plan",
    "planHash"
  ],
  "deployment.PlanRejected": [
    "deploymentId",
    "reason"
  ],
  "match.Decided": [
    "resourceId",
    "winner",
    "ranking",
    "rejectedCandidates",
    "objective",
    "tie",
    "catalogContentHash"
  ],
  "set.Created": [
    "setId",
    "campId",
    "contentHash"
  ],
  "delta.Opened": [
    "deltaId",
    "baseSetId"
  ],
  "delta.Updated": [
    "deltaId",
    "operations"
  ],
  "delta.Applied": [
    "deltaId",
    "resultingSetId"
  ],
  "resource.Pending": [
    "resourceId",
    "deps"
  ],
  "resource.Provisioning": [
    "resourceId",
    "provider",
    "driver"
  ],
  "resource.Provisioned": [
    "resourceId",
    "outputs"
  ],
  "resource.DriftDetected": [
    "resourceId",
    "driftFingerprint",
    "providerStateHash",
    "desiredStateHash",
    "changes"
  ],
  "resource.DriftQueued": [
    "resourceId",
    "driftFingerprint",
    "leaseHolder"
  ],
  "resource.Updating": [
    "resourceId",
    "previousVersion",
    "targetVersion"
  ],
  "resource.RefreshFailed": [
    "resourceId",
    "classification",
    "reason",
    "retryAfterMs"
  ],
  "resource.DriftSuppressed": [
    "resourceId",
    "driftFingerprint",
    "reason"
  ],
  "resource.Failed": [
    "resourceId",
    "reason"
  ],
  "resource.Destroying": [
    "resourceId",
    "reason"
  ],
  "resource.Destroyed": [
    "resourceId",
    "finalStateHash"
  ],
  "resource.Adopted": [
    "resourceId",
    "externalId"
  ],
  "exec.Started": [
    "execId",
    "resourceId",
    "programHash"
  ],
  "exec.Output": [
    "execId",
    "stream",
    "line"
  ],
  "exec.Succeeded": [
    "execId",
    "outputsHash"
  ],
  "exec.Failed": [
    "execId",
    "reason"
  ],
  "dispatch.Decided": [
    "dispatchId",
    "category",
    "selectedProvider",
    "objective",
    "ledgerInput",
    "candidates"
  ],
  "deployment.RolledBack": [
    "deploymentId",
    "targetSetId",
    "reason"
  ],
  "deployment.Deployed": [
    "deploymentId",
    "setId",
    "resourceIds"
  ]
};
