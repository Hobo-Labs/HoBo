import type { DevStateStore } from "./dev-state-store.js";
import { isJsonString, type JsonValue } from "./json.js";


export interface ReloadHandlerInput {
  path: string;
  source: string;
}

export interface ReloadHandlerResult {
  ok: boolean;
  code: string;
  message?: string;
  handlerGeneration?: number;
  daemonAlive: boolean;
}

export function assertValidModuleSource(source: string): void {
  const text = source.replace(/\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*=/g, "const $1 =");
  new Function(text);
}

export async function reloadHandler(
  store: DevStateStore,
  input: ReloadHandlerInput,
  daemonAlive: () => boolean,
): Promise<ReloadHandlerResult> {
  const path = requireNonEmptyString(input.path, "path");
  try {
    assertValidModuleSource(requireNonEmptyString(input.source, "source"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid source";
    await store.append({
      family: "dev.ReloadFailed",
      payload: { path, code: "HOBO_DEV_RELOAD_ERROR", message },
    });
    return {
      ok: false,
      code: "HOBO_DEV_RELOAD_ERROR",
      message: `${path}: ${message}`,
      daemonAlive: daemonAlive(),
    };
  }

  const state = await store.append({
    family: "dev.HandlerReloaded",
    payload: { path },
  });
  return {
    ok: true,
    code: "HOBO_DEV_RELOADED",
    handlerGeneration: state.handlerGeneration,
    daemonAlive: daemonAlive(),
  };
}

function requireNonEmptyString(value: JsonValue, fieldName: string): string {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}
