import { SecretValue } from "../core/secret-value.js";
import type { SecretsPort } from "../core/ports/secrets.js";
import { SecretUnavailableError, UnresolvedBindingError } from "../core/ports/secrets.js";
import type { ConfigEntry, ConfigResolvedSource } from "../bindles/types.js";
import type { EventStore } from "./event-store.js";
import { nextEventId } from "./event-store.js";
import { registerSecretForRedaction } from "./redaction.js";

export type CampConfig = Record<string, string | number | boolean>;

export type BindingHandle = {
  readonly kind: "binding-handle";
  readonly ref: string;
  readonly camp: string;
};

export type ResolvedConfigValue =
  | string
  | number
  | boolean
  | SecretValue
  | BindingHandle
  | { readonly kind: "static-secret-hatch-required"; readonly ref: string; readonly reason: string };

export type ConfigResolverOptions = {
  readonly camp: string;
  readonly campConfig?: CampConfig;
  readonly secrets: SecretsPort;
  readonly eventStore: EventStore;
  readonly bindings?: ReadonlyMap<string, BindingHandle>;
  readonly accessorId?: string;
  readonly isLocalCamp?: boolean;
};

export type ConfigResolver = {
  resolve(key: string, entry: ConfigEntry): Promise<ResolvedConfigValue>;
};

export function createConfigResolver(options: ConfigResolverOptions): ConfigResolver {
  const camp = options.camp;
  const campConfig = options.campConfig ?? {};
  const bindings = options.bindings ?? new Map<string, BindingHandle>();
  const isLocal = options.isLocalCamp ?? camp === "local";

  async function resolve(key: string, entry: ConfigEntry): Promise<ResolvedConfigValue> {
    switch (entry.source.kind) {
      case "camp-env":
        return resolveCampEnv(key, entry);
      case "secret-ref":
        return resolveSecretRef(key, entry);
      case "binding":
        return resolveBinding(key, entry);
      default:
        // SAFETY: assertion to `throw new Error(unsupported config source kind ${(entry.source as { kind: strin` is required at this boundary.
        throw new Error(`unsupported config source kind ${(entry.source as { kind: string }).kind}`);
    }
  }

  function resolveCampEnv(key: string, entry: ConfigEntry): ResolvedConfigValue {
    const ref = entry.source.ref ?? key;
    if (!Object.hasOwn(campConfig, ref)) {
      if (entry.required) {
        throw new Error(`camp config ${ref} is required`);
      }
      emitConfigResolved(key, ref, "camp-env");
      return entry.defaultType === "number" ? 0 : entry.defaultType === "boolean" ? false : "";
    }

    emitConfigResolved(key, ref, "camp-env");
    // SAFETY: assertion to `return campConfig[ref] as string | number | boolean;` is required at this boundary.
    return campConfig[ref] as string | number | boolean;
  }

  async function resolveSecretRef(key: string, entry: ConfigEntry): Promise<ResolvedConfigValue> {
    const ref = entry.source.ref ?? key;

    if (!isLocal) {
      emitConfigResolved(key, ref, "static-secret-hatch");
      return { kind: "static-secret-hatch-required", ref, reason: "provider-federation-unavailable" };
    }

    try {
      const secret = await options.secrets.get(ref, {
        camp,
        ...(options.accessorId ? { accessorId: options.accessorId } : undefined),
      });
      registerSecretForRedaction(secret.reveal());

      options.eventStore.append({
        type: "secret.Accessed",
        id: nextEventId("secret-accessed"),
        data: {
          ref,
          camp,
          source: "dev",
          accessorId: options.accessorId,
          productionDeployable: false as const,
        },
      });

      emitConfigResolved(key, ref, "dev-secret");
      return secret;
    } catch (error) {
      const reason = error instanceof SecretUnavailableError ? error.reason : String(error);
      options.eventStore.append({
        type: "secret.Unavailable",
        id: nextEventId("secret-unavailable"),
        data: { ref, camp, reason },
      });
      throw error instanceof SecretUnavailableError
        ? error
        : new SecretUnavailableError(ref, camp, reason);
    }
  }

  function resolveBinding(key: string, entry: ConfigEntry): ResolvedConfigValue {
    const ref = entry.source.ref ?? key;
    const handle = bindings.get(ref);
    if (!handle) {
      throw new UnresolvedBindingError(ref, camp);
    }
    emitConfigResolved(key, ref, "bound-resource");
    return handle;
  }

  function emitConfigResolved(key: string, ref: string, source: ConfigResolvedSource): void {
    options.eventStore.append({
      type: "config.Resolved",
      id: nextEventId("config-resolved"),
      data: { key, ref, source, camp },
    });
  }

  return { resolve };
}
