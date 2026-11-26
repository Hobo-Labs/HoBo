import { createHash } from "node:crypto";

import { inferJunctionConnectivity } from "../../junction-connectivity-inference-spike/src/junction-connectivity-inference.js";
import { isJsonObject } from "./json.js";


export const JUNCTION_CONNECTIVITY_PLAN_SCHEMA_VERSION = "hobo.junction-connectivity-plan/v1";

export function planJunctionConnectivity(input) {
  const inferenceResult = inferJunctionConnectivity(input);
  if (!inferenceResult.ok) return inferenceResult;

  const { inference } = inferenceResult;
  const deliveriesByYard = Object.fromEntries(
    Object.entries(inference.halvesByYard).map(([yardId, halves]) => [
      yardId,
      halves.map((half, index) => deliveryForHalf({ half, inference, index }))
    ])
  );

  const planWithoutHash = {
    schemaVersion: JUNCTION_CONNECTIVITY_PLAN_SCHEMA_VERSION,
    junctionId: inference.junctionId,
    junctionEvent: {
      ...inference.event,
      contentHash: inference.contentHash
    },
    edges: inference.edges,
    deliveriesByYard,
    sharedStateWrites: []
  };

  return {
    ok: true,
    plan: deepFreeze({
      ...planWithoutHash,
      contentHash: stableDigest(planWithoutHash)
    })
  };
}

export function validateJunctionConnectivityPlan(plan) {
  if (!plan || !isJsonObject(plan) || Array.isArray(plan)) {
    return invalid("junction.plan.invalid", "plan must be an object");
  }
  if (plan.schemaVersion !== JUNCTION_CONNECTIVITY_PLAN_SCHEMA_VERSION) {
    return invalid("junction.schema.unsupported", `schemaVersion must be ${JUNCTION_CONNECTIVITY_PLAN_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(plan.sharedStateWrites) || plan.sharedStateWrites.length !== 0) {
    return invalid("junction.shared-state.forbidden", "Junction connectivity plan must not write shared mutable state");
  }
  if (!plan.deliveriesByYard || !isJsonObject(plan.deliveriesByYard) || Array.isArray(plan.deliveriesByYard)) {
    return invalid("junction.delivery.invalid", "deliveriesByYard must be an object keyed by Yard id");
  }

  const actualHalfKeys = new Set();
  for (const [yardId, deliveries] of Object.entries(plan.deliveriesByYard)) {
    if (!Array.isArray(deliveries)) {
      return invalid("junction.delivery.invalid", `deliveriesByYard.${yardId} must be an array`);
    }
    for (const delivery of deliveries) {
      if (delivery?.yardId !== yardId || delivery?.body?.yardId !== yardId) {
        const leakedYard = delivery?.body?.yardId ?? delivery?.yardId ?? "unknown";
        return invalid(
          "junction.delivery.yard-leak",
          `delivery for ${leakedYard} cannot be placed in ${yardId} resource log`
        );
      }
      if (delivery.streamId !== `yard:${yardId}:resources`) {
        return invalid("junction.delivery.stream", `delivery for ${yardId} must land in that Yard's resource log`);
      }
      actualHalfKeys.add(halfKey(delivery.body));
    }
  }

  const expectedHalfKeys = new Set((plan.edges ?? []).flatMap((edge) => (edge.halves ?? []).map(halfKey)));
  if (!sameSet(expectedHalfKeys, actualHalfKeys)) {
    return invalid(
      "junction.delivery.incomplete",
      "delivery projection must contain exactly one delivered half for every edge half"
    );
  }

  return { ok: true };
}

function deliveryForHalf({ half, inference, index }) {
  return {
    type: "resource.JunctionConnectivityHalfPlanned",
    streamId: `yard:${half.yardId}:resources`,
    yardId: half.yardId,
    ordinal: index,
    body: {
      ...half,
      junctionId: inference.junctionId,
      inferredByEventType: inference.event.type,
      inferenceHash: inference.contentHash
    }
  };
}

function invalid(code, reason) {
  return { ok: false, code, reason };
}

function halfKey(half) {
  return `${half?.yardId}:${half?.edgeId}:${half?.role}`;
}

function sameSet(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function stableDigest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || !isJsonObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return value;
}
