import { isJsonNumber, isJsonObject } from "../json.js";
export const TENANT_OTLP_EXPORT_SCHEMA = "hobo.otlp.tenant-export/v1";

export function createTenantOtlpBackend({ tenantId, endpoint }) {
  const batches = [];

  return {
    tenantId,
    endpoint,
    exportBatch(batch) {
      validateBatch(batch, tenantId);
      const record = {
        schema: TENANT_OTLP_EXPORT_SCHEMA,
        tenantId,
        endpoint,
        receivedAt: batch.receivedAt ?? new Date().toISOString(),
        spans: batch.spans.map(cloneSpan),
        rewards: batch.rewards.map(cloneReward),
      };
      batches.push(record);
      return { accepted: true, batchId: `otlp-${batches.length}` };
    },
    batches: () => structuredClone(batches),
  };
}

export function exportTrainingTelemetry({ backend, tenantId, spans, rewards }) {
  if (!backend || !(backend.exportBatch instanceof Function)) {
    throw new TypeError("backend must expose exportBatch");
  }
  if (tenantId !== backend.tenantId) {
    throw new Error(`tenant mismatch: ${tenantId} !== ${backend.tenantId}`);
  }

  return backend.exportBatch({
    tenantId,
    spans: spans ?? [],
    rewards: rewards ?? [],
    receivedAt: new Date().toISOString(),
  });
}

function validateBatch(batch, tenantId) {
  if (!batch || !isJsonObject(batch)) {
    throw new TypeError("batch must be an object");
  }
  if (batch.tenantId !== tenantId) {
    throw new Error("batch tenantId must match backend tenantId");
  }
  if (!Array.isArray(batch.spans)) {
    throw new TypeError("batch.spans must be an array");
  }
  if (!Array.isArray(batch.rewards)) {
    throw new TypeError("batch.rewards must be an array");
  }

  for (const span of batch.spans) {
    if (!span?.name || !span?.kind) {
      throw new TypeError("each span requires name and kind");
    }
    if (!span.traceId || !span.spanId) {
      throw new TypeError("each span requires traceId and spanId");
    }
  }

  for (const reward of batch.rewards) {
    if (!reward?.trajectoryId || !isJsonNumber(reward.reward)) {
      throw new TypeError("each reward requires trajectoryId and numeric reward");
    }
  }
}

function cloneSpan(span) {
  return structuredClone(span);
}

function cloneReward(reward) {
  return structuredClone(reward);
}
