export {
  CONFIG_SCHEMA_VERSION,
  config,
  env,
  fromBinding,
  secretRef,
} from "./bindles/schema.js";

export {
  emitConfigManifest,
  serializeConfigManifest,
  scanSerializedManifestForValues,
  canonicalJson,
} from "./bindles/manifest.js";

export type {
  ConfigContract,
  ConfigEntry,
  ConfigManifest,
  ConfigAccessors,
  ConfigValue,
  ConfigAuditEvent,
  ConfigResolvedEvent,
  SecretAccessedEvent,
  SecretUnavailableEvent,
} from "./bindles/types.js";

export { SecretValue, REDACTED } from "./core/secret-value.js";

export type { SecretsPort, SecretAccessContext } from "./core/ports/secrets.js";
export { SecretUnavailableError, UnresolvedBindingError } from "./core/ports/secrets.js";

export { createConfigResolver } from "./runtime/resolver.js";
export type { ConfigResolver, CampConfig, BindingHandle } from "./runtime/resolver.js";

export { createConfigContext } from "./runtime/context.js";
export { createRuntimeCtx } from "./runtime/ctx.js";
export type { RuntimeCtx } from "./runtime/ctx.js";

export {
  registerSecretForRedaction,
  clearSecretRegistry,
  scrubAtCapture,
  assertNoPlaintextConformance,
} from "./runtime/redaction.js";

export { createInMemoryEventStore, resetEventSeq } from "./runtime/event-store.js";
export type { EventStore } from "./runtime/event-store.js";

export { createDevSecretsAdapter, parseEnvLocal } from "./runtime-local/secrets-dev.js";
export type { DevSecretsAdapter } from "./runtime-local/secrets-dev.js";

export { cfg } from "./hello-bindle/config.js";
export { helloHandler } from "./hello-bindle/handler.js";
