import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";
export type ResourceId = string & { readonly __brand: "ResourceId" };
export type DesiredRef = string & { readonly __brand: "DesiredRef" };
export type Environment = string & { readonly __brand: "Environment" };

export type DriftResource = {
  id: ResourceId;
  desiredRef: DesiredRef;
  environment: Environment;
};

export type GetDriftRequest = {
  resourceId: ResourceId | null;
  projection: JsonValue[];
};

export type HealDriftRequest = {
  resourceId: ResourceId;
  projection: JsonValue[];
};

export function parseResourceId(value: JsonValue): ResourceId {
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  return requireNonEmptyString(value, "resourceId") as ResourceId;
}

export function parseDesiredRef(value: JsonValue, fallbackId: ResourceId): DesiredRef {
  if (value == null) {
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    return `set:desired@${fallbackId}` as DesiredRef;
  }
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  return requireNonEmptyString(value, "desiredRef") as DesiredRef;
}

export function parseEnvironment(value: JsonValue): Environment {
  if (value == null) {
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    return "staging" as Environment;
  }
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  return requireNonEmptyString(value, "environment") as Environment;
}

export function parseDriftResource(value: JsonValue): DriftResource {
  if (value == null || !isJsonObject(value)) {
    throw new TypeError("drift resource must be an object");
  }
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const resource = value as JsonObject;
  const id = parseResourceId(resource.id);
  return {
    id,
    desiredRef: parseDesiredRef(resource.desiredRef, id),
    environment: parseEnvironment(resource.environment),
  };
}

export function parseDriftResources(value: JsonValue): DriftResource[] {
  if (!Array.isArray(value)) {
    throw new TypeError("resources must be an array");
  }
  return value.map(parseDriftResource);
}

export function parseGetDriftRequest(value: JsonValue): GetDriftRequest {
  if (value == null || !isJsonObject(value)) {
    throw new TypeError("get drift request must be an object");
  }
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const request = value as JsonObject;
  const resourceId =
    request.resourceId == null ? null : parseResourceId(request.resourceId);
  if (!Array.isArray(request.projection)) {
    throw new TypeError("projection must be an array");
  }
  return {
    resourceId,
    projection: request.projection,
  };
}

export function parseHealDriftRequest(value: JsonValue): HealDriftRequest {
  if (value == null || !isJsonObject(value)) {
    throw new TypeError("heal drift request must be an object");
  }
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const request = value as JsonObject;
  if (!Array.isArray(request.projection)) {
    throw new TypeError("projection must be an array");
  }
  return {
    resourceId: parseResourceId(request.resourceId),
    projection: request.projection,
  };
}

function requireNonEmptyString(value: JsonValue, fieldName: string): string {
  if (!isJsonString(value) || value.trim() === "") {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}
