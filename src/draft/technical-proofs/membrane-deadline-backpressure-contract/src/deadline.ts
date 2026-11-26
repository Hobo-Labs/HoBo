import { isJsonObject, type JsonValue, type JsonObject } from "./json.js";
// domain-view: parse-produced draft-proof record; its wire form is the Deadline proto message in data-models/.
export interface Deadline {
  source: "caller" | "inherited";
  startedAtMs: number;
  expiresAtMs: number;
  remainingAtDispatchMs: number;
}

export function deriveDeadline(
  nowMs: number,
  opts: {
    deadlineAtMs?: number;
    timeoutMs?: number;
    parentDeadline?: Deadline | null;
  } = {},
): Deadline | null {
  const parent = opts.parentDeadline ?? null;
  let requestedExpiresAtMs: number | null = null;
  if (Number.isFinite(opts.deadlineAtMs)) {
    requestedExpiresAtMs = opts.deadlineAtMs ?? null;
  } else if (Number.isFinite(opts.timeoutMs) && opts.timeoutMs !== undefined) {
    requestedExpiresAtMs = nowMs + opts.timeoutMs;
  }

  if (!parent && requestedExpiresAtMs === null) {
    return null;
  }

  const expiresAtMs =
    parent && requestedExpiresAtMs !== null
      ? Math.min(parent.expiresAtMs, requestedExpiresAtMs)
      : (parent?.expiresAtMs ?? requestedExpiresAtMs);

  return Object.freeze({
    source:
      parent &&
      (requestedExpiresAtMs === null || parent.expiresAtMs <= requestedExpiresAtMs)
        ? "inherited"
        : "caller",
    startedAtMs: nowMs,
    // SAFETY: assertion to `expiresAtMs: expiresAtMs as number,` is required at this boundary.
    expiresAtMs: expiresAtMs as number,
    // SAFETY: assertion to `remainingAtDispatchMs: Math.max(0, (expiresAtMs as number) - nowMs),` is required at this boundary.
    remainingAtDispatchMs: Math.max(0, (expiresAtMs as number) - nowMs),
  });
}

export function parseDeadline(raw: JsonValue): Deadline {
  if (!raw || !isJsonObject(raw)) {
    throw new TypeError("deadline must be an object");
  }

  // SAFETY: assertion to `const value = raw as JsonObject;` is required at this boundary.
  const value = raw as JsonObject;
  const source = value.source;
  if (source !== "caller" && source !== "inherited") {
    throw new TypeError("deadline source must be caller or inherited");
  }

  const startedAtMs = value.startedAtMs;
  const expiresAtMs = value.expiresAtMs;
  const remainingAtDispatchMs = value.remainingAtDispatchMs;

  if (!Number.isFinite(startedAtMs) || !Number.isFinite(expiresAtMs)) {
    throw new TypeError("deadline timestamps must be finite numbers");
  }

  // SAFETY: assertion to `if ((expiresAtMs as number) < (startedAtMs as number)) {` is required at this boundary.
  if ((expiresAtMs as number) < (startedAtMs as number)) {
    throw new TypeError("expires_at_ms must be >= started_at_ms");
  }

  // SAFETY: assertion to `if (!Number.isFinite(remainingAtDispatchMs) || (remainingAtDispatchMs as number)` is required at this boundary.
  if (!Number.isFinite(remainingAtDispatchMs) || (remainingAtDispatchMs as number) < 0) {
    throw new TypeError("remaining_at_dispatch_ms must be >= 0");
  }

  return Object.freeze({
    source,
    // SAFETY: assertion to `startedAtMs: startedAtMs as number,` is required at this boundary.
    startedAtMs: startedAtMs as number,
    // SAFETY: assertion to `expiresAtMs: expiresAtMs as number,` is required at this boundary.
    expiresAtMs: expiresAtMs as number,
    // SAFETY: assertion to `remainingAtDispatchMs: remainingAtDispatchMs as number,` is required at this boundary.
    remainingAtDispatchMs: remainingAtDispatchMs as number,
  });
}
