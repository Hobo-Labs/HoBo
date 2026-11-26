import type { ConfigContract, ConfigAccessors, ConfigValue } from "../bindles/types.js";
import type { ConfigResolver, ResolvedConfigValue } from "./resolver.js";
import { SecretValue } from "../core/secret-value.js";
import { isJsonString, isJsonNumber, isJsonBoolean, isJsonObject, type JsonValue } from "../json.js";


export interface ConfigContext<TContract extends ConfigContract> {
  readonly config: ConfigAccessors<TContract>;
}

export function createConfigContext<const TContract extends ConfigContract>(
  contract: TContract,
  resolver: ConfigResolver,
): ConfigContext<TContract> {
  const accessors: Record<string, () => Promise<JsonValue>> = {};

  // SAFETY: assertion to `for (const key of Object.keys(contract.entries) as Array<keyof TContract["entrie` is required at this boundary.
  for (const key of Object.keys(contract.entries) as Array<keyof TContract["entries"] & string>) {
    const entry = contract.entries[key];
    if (!entry) {
      throw new Error(`config entry ${key} is not declared`);
    }
    accessors[key] = async () => {
      const resolved = await resolver.resolve(key, entry);
      // SAFETY: assertion to `return normalizeAccessorValue(resolved) as ConfigValue<TContract["entries"][type` is required at this boundary.
      return normalizeAccessorValue(resolved) as ConfigValue<TContract["entries"][typeof key]>;
    };
  }

  // SAFETY: assertion to `return { config: accessors as ConfigAccessors<TContract> };` is required at this boundary.
  return { config: accessors as ConfigAccessors<TContract> };
}

function normalizeAccessorValue(resolved: ResolvedConfigValue): string | number | boolean | SecretValue {
  if (resolved instanceof SecretValue) {
    return resolved;
  }
  if (
    isJsonString(resolved) ||
    isJsonNumber(resolved) ||
    isJsonBoolean(resolved)
  ) {
    return resolved;
  }
  if (resolved && isJsonObject(resolved) && isJsonString(resolved.kind)) {
    const kind = resolved.kind;
    if (kind === "binding-handle" && isJsonString(resolved.ref)) {
      return `[binding:${resolved.ref}]`;
    }
    if (kind === "static-secret-hatch-required" && isJsonString(resolved.ref)) {
      throw new Error(`static secret hatch required for ${resolved.ref}`);
    }
  }
  throw new Error("unsupported resolved config value");
}
