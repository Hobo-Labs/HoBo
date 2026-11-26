const REQUIRED_TAGS = ["tenant", "deployment", "resource"];

export function assertProviderTagContract(providerObjects) {
  for (const providerObject of providerObjects) {
    const missing = REQUIRED_TAGS.filter((tag) => !providerObject.tags?.[tag]);
    if (missing.length > 0) {
      throw new Error(
        `provider object ${providerObject.providerId ?? "<unknown>"} missing required provider tags: ${missing.join(", ")}`,
      );
    }
  }
}

export function resolveReconcileConflict({ contenders }) {
  if (!Array.isArray(contenders) || contenders.length === 0) {
    throw new Error("at least one reconcile contender is required");
  }

  const ordered = contenders
    .map((contender) => ({ ...contender }))
    .sort((left, right) => {
      const byPriority = left.leasePriority - right.leasePriority;
      if (byPriority !== 0) {
        return byPriority;
      }

      const bySequence = left.sequence - right.sequence;
      if (bySequence !== 0) {
        return bySequence;
      }

      return left.writer.localeCompare(right.writer);
    });

  const [winner, ...losers] = ordered;
  const events = [
    {
      type: "reconcile.ConflictWinnerRecorded",
      writer: winner.writer,
      leasePriority: winner.leasePriority,
      sequence: winner.sequence,
    },
    ...losers.map((loser) => ({
      type: "reconcile.ConflictLoserRecorded",
      writer: loser.writer,
      leasePriority: loser.leasePriority,
      sequence: loser.sequence,
      lostTo: winner.writer,
    })),
  ];

  return {
    winner: winner.writer,
    losers: losers.map((loser) => loser.writer),
    events,
  };
}

export async function runDriftOrphanSweep({
  tenantId,
  deploymentId,
  stateResources = [],
  providerObjects = [],
  rollback = false,
  manualChangePolicy = "revert",
  eventLog = [],
  destroyProviderObject = () => ({ status: "destroyed" }),
  applyProviderObject = () => ({ status: "applied" }),
}) {
  assertProviderTagContract(providerObjects);

  const events = eventLog.map(clone);
  const actions = [];
  const stateByResource = new Map(
    stateResources.map((resource) => [resource.resourceId, resource]),
  );
  const scopedObjects = providerObjects.filter((providerObject) =>
    isInScope(providerObject, { tenantId, deploymentId }),
  );
  const recordedObjects = scopedObjects.filter((providerObject) =>
    stateByResource.has(providerObject.tags.resource),
  );
  const orphanObjects = scopedObjects.filter((providerObject) =>
    !stateByResource.has(providerObject.tags.resource),
  );

  let status = "reconciled";

  if (rollback) {
    events.push({
      type: "reconcile.RollbackWon",
      tenantId,
      deploymentId,
      reason: "rollback-preempts-drift-reconciliation",
    });

    for (const providerObject of recordedObjects) {
      const action = {
        type: "destroy-recorded-state",
        providerId: providerObject.providerId,
        resourceId: providerObject.tags.resource,
      };
      actions.push(action);

      const result = normalizeResult(await destroyProviderObject({
        providerId: providerObject.providerId,
        resourceId: providerObject.tags.resource,
        reason: "rollback",
      }));

      if (result.status === "destroyed") {
        events.push({
          type: "reconcile.RecordedStateDestroyed",
          tenantId,
          deploymentId,
          providerId: providerObject.providerId,
          resourceId: providerObject.tags.resource,
        });
      } else {
        status = "partial";
        events.push({
          type: "reconcile.RecordedStateDestroyFailed",
          tenantId,
          deploymentId,
          providerId: providerObject.providerId,
          resourceId: providerObject.tags.resource,
          reason: result.reason ?? result.status,
        });
      }
    }
  } else {
    for (const providerObject of recordedObjects) {
      const state = stateByResource.get(providerObject.tags.resource);
      if (state?.desired === undefined || sameValue(state.desired, providerObject.observed ?? {})) {
        continue;
      }

      if (manualChangePolicy === "adopt") {
        const action = {
          type: "adopt-manual-change",
          providerId: providerObject.providerId,
          resourceId: providerObject.tags.resource,
          observed: clone(providerObject.observed ?? {}),
        };
        actions.push(action);
        events.push({
          type: "drift.ManualChangeDecisionRecorded",
          tenantId,
          deploymentId,
          providerId: providerObject.providerId,
          resourceId: providerObject.tags.resource,
          decision: "adopt",
        });
      } else {
        const action = {
          type: "revert-manual-change",
          providerId: providerObject.providerId,
          resourceId: providerObject.tags.resource,
          desired: clone(state.desired),
        };
        actions.push(action);
        await applyProviderObject({
          providerId: providerObject.providerId,
          resourceId: providerObject.tags.resource,
          desired: state.desired,
        });
        events.push({
          type: "drift.ManualChangeDecisionRecorded",
          tenantId,
          deploymentId,
          providerId: providerObject.providerId,
          resourceId: providerObject.tags.resource,
          decision: "revert",
        });
      }
    }
  }

  const sweepStatus = await sweepOrphans({
    tenantId,
    deploymentId,
    orphanObjects,
    events,
    actions,
    destroyProviderObject,
  });

  if (sweepStatus === "partial") {
    status = "partial";
  }

  return {
    status,
    actions,
    events,
  };
}

async function sweepOrphans({
  tenantId,
  deploymentId,
  orphanObjects,
  events,
  actions,
  destroyProviderObject,
}) {
  const alreadySwept = new Set(
    events
      .filter((event) =>
        event.type === "drift.OrphanSwept" &&
        event.tenantId === tenantId &&
        event.deploymentId === deploymentId,
      )
      .map((event) => event.providerId),
  );
  let status = "reconciled";

  for (const providerObject of orphanObjects) {
    if (alreadySwept.has(providerObject.providerId)) {
      continue;
    }

    const action = {
      type: "sweep-orphan",
      providerId: providerObject.providerId,
      resourceId: providerObject.tags.resource,
    };
    actions.push(action);

    const result = normalizeResult(await destroyProviderObject({
      providerId: providerObject.providerId,
      resourceId: providerObject.tags.resource,
      reason: "created-but-not-in-state",
    }));

    if (result.status === "destroyed") {
      events.push({
        type: "drift.OrphanSwept",
        tenantId,
        deploymentId,
        providerId: providerObject.providerId,
        resourceId: providerObject.tags.resource,
      });
    } else {
      status = "partial";
      events.push({
        type: "drift.OrphanSweepFailed",
        tenantId,
        deploymentId,
        providerId: providerObject.providerId,
        resourceId: providerObject.tags.resource,
        reason: result.reason ?? result.status,
      });
    }
  }

  return status;
}

function isInScope(providerObject, { tenantId, deploymentId }) {
  return (
    providerObject.tags.tenant === tenantId &&
    providerObject.tags.deployment === deploymentId
  );
}

function normalizeResult(result) {
  return result ?? { status: "destroyed" };
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
