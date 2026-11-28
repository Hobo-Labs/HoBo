import { isJsonString, type JsonValue } from "./json.js";
export type ActorKey = string & { readonly __brand: "ActorKey" };
export type HolderId = string & { readonly __brand: "HolderId" };

export function parseActorKey(value: JsonValue): ActorKey {
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  return requireNonEmptyString(value, "key") as ActorKey;
}

export function parseHolderId(value: JsonValue): HolderId {
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  return requireNonEmptyString(value, "holderId") as HolderId;
}

function requireNonEmptyString(value: JsonValue, fieldName: string): string {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}
