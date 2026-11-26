import {
  createIdentityEvent,
  validateIdentityEvent,
} from "../../identity-event-contract/src/identity-event-contract.js";
import { isJsonString, isJsonObject } from "./json.js";


const EVENT_ACTOR = { kind: "service", id: "yard/config" };

export class SecretValue {
  #value;

  constructor(value, metadata) {
    this.#value = value;
    this.metadata = deepFreeze(clone(metadata));
  }

  reveal() {
    return this.#value;
  }

  toJSON() {
    return "[secret:redacted]";
  }

  toString() {
    return "[secret:redacted]";
  }
}

export function createSecretlessConfigResolver(options = {}) {
  const tokenBroker = requireTokenBroker(options.tokenBroker);
  const secrets = normalizeSecretsAdapters(options.secrets ?? {});
  const now = options.now ?? (() => new Date());
  const eventSink = options.eventSink ?? (() => {});
  const idFactory = options.idFactory ?? defaultIdFactory();
  let seq = 1;

  async function resolve(key, entry, context) {
    const normalized = normalizeResolutionInput(key, entry, context);

    switch (normalized.entry.source.kind) {
      case "binding":
        return resolveBoundResource(normalized);
      case "secret-ref":
        return resolveSecretRef(normalized);
      case "camp-env":
        return resolveCampConfig(normalized);
      default:
        throw new Error(`unsupported config source kind ${normalized.entry.source.kind}`);
    }
  }

  async function resolveBoundResource({ key, entry, camp, subject, svid }) {
    const bindingRef = entry.source.ref;
    const binding = requireCampRecord(camp.bindings, bindingRef, "binding");
    const scope = normalizeScope(binding, bindingRef);
    const token = await requestBrokeredToken({
      camp,
      flow: binding.flow,
      key,
      provider: binding.provider,
      scope,
      subject,
      svid,
    });

    emitConfigResolved({
      camp,
      key,
      source: "bound-resource",
      data: {
        bindingRef,
        provider: binding.provider,
        resource: scope.resource,
        tokenUsageId: token.usageId,
      },
      causationId: token.eventId,
    });

    return deepFreeze({
      kind: "bound-resource-token",
      key,
      source: "bound-resource",
      bindingRef,
      provider: binding.provider,
      credentialRef: token.credentialRef,
      tokenUsageId: token.usageId,
    });
  }

  async function resolveSecretRef({ key, entry, camp, subject, svid }) {
    const ref = entry.source.ref;
    const declaration = requireCampRecord(camp.secretRefs, ref, "secretRef");

    if (declaration.federation !== true || !declaration.flow) {
      emitConfigResolved({
        camp,
        key,
        source: "static-secret-hatch",
        data: {
          secretRef: ref,
          provider: declaration.provider,
          hatch: "bounded-static-secret-required",
        },
      });
      return deepFreeze({
        kind: "static-secret-hatch-required",
        key,
        provider: declaration.provider,
        reason: "provider-federation-unavailable",
        source: "static-secret-hatch",
      });
    }

    const adapter = requireSecretsAdapter(secrets, declaration.provider);
    const scope = normalizeScope(
      declaration.scope ?? {
        port: "secrets",
        resource: declaration.path,
        action: "read",
      },
      ref,
    );
    const token = await requestBrokeredToken({
      camp,
      flow: declaration.flow,
      key,
      provider: declaration.provider,
      scope,
      subject,
      svid,
    });
    const read = await adapter.readSecret({
      campId: camp.id,
      provider: declaration.provider,
      path: requireString(declaration.path, `camp.secretRefs.${ref}.path`),
      secretRef: ref,
      credentialRef: token.credentialRef,
      tokenUsageId: token.usageId,
    });
    const value = normalizeSecretRead(read, ref);
    const secretValue = new SecretValue(value, {
      campId: camp.id,
      provider: declaration.provider,
      ref,
      source: "provider-secret-store",
    });
    const accessed = emitSecretAccessed({
      camp,
      provider: declaration.provider,
      ref,
      tokenUsageId: token.usageId,
      causationId: token.eventId,
    });

    emitConfigResolved({
      camp,
      key,
      source: "provider-secret-store",
      data: {
        secretRef: ref,
        provider: declaration.provider,
        tokenUsageId: token.usageId,
      },
      causationId: accessed.id,
    });

    return deepFreeze({
      kind: "secret-value",
      key,
      source: "provider-secret-store",
      provider: declaration.provider,
      value: secretValue,
      tokenUsageId: token.usageId,
    });
  }

  function resolveCampConfig({ key, entry, camp }) {
    const ref = entry.source.ref ?? key;
    const config = camp.config ?? {};
    if (!Object.hasOwn(config, ref)) {
      if (entry.required === true) {
        throw new Error(`camp config ${ref} is required`);
      }
      return deepFreeze({
        kind: "camp-config",
        key,
        source: "camp-config",
        value: undefined,
      });
    }

    emitConfigResolved({
      camp,
      key,
      source: "camp-config",
      data: { configKey: ref },
    });

    return deepFreeze({
      kind: "camp-config",
      key,
      source: "camp-config",
      value: config[ref],
    });
  }

  async function requestBrokeredToken({ camp, flow, key, provider, scope, subject, svid }) {
    if (!flow) {
      throw new Error(`config ${key} requires provider federation flow`);
    }

    const requestId = idFactory("config-token-request");
    const response = await tokenBroker.requestToken({
      requestId,
      provider,
      subject,
      svid,
      scope,
      flow,
      campId: camp.id,
      configKey: key,
    });

    if (!response?.ok) {
      throw new Error(response?.reason ?? `token request ${requestId} denied`);
    }

    const tokenUsed = response.events?.find((event) => event.type === "token.Used");
    if (!tokenUsed) {
      throw new Error(`token request ${requestId} did not emit token.Used`);
    }

    return {
      credentialRef: response.credential?.credentialRef ?? response.credential?.tokenRef,
      eventId: tokenUsed.id,
      usageId: tokenUsed.data.usageId,
    };
  }

  function emitConfigResolved({ camp, key, source, data = {}, causationId }) {
    return emitIdentityEvent("config.Resolved", {
      data: {
        configRef: `config://${camp.id}/${key}`,
        source,
        ...data,
      },
      causationId,
    });
  }

  function emitSecretAccessed({ camp, provider, ref, tokenUsageId, causationId }) {
    return emitIdentityEvent("secret.Accessed", {
      data: {
        secretRef: `secret://${camp.id}/${ref}`,
        source: `provider-secret-store:${provider}`,
        tokenUsageId,
        provider,
        pathRef: ref,
      },
      causationId,
    });
  }

  function emitIdentityEvent(type, { data, causationId }) {
    const event = createIdentityEvent(type, data, {
      id: `evt-${type.toLowerCase().replaceAll(".", "-")}-${idFactory("event")}`,
      actor: EVENT_ACTOR,
      time: now().toISOString(),
      seq: seq++,
      correlationId: "corr-config-resolution",
      causationId: causationId ?? "cmd-config-resolution",
    });
    const validation = validateIdentityEvent(event);
    if (!validation.ok) {
      throw new Error(`invalid ${type} event: ${validation.errors.join("; ")}`);
    }
    eventSink(event);
    return event;
  }

  return deepFreeze({
    resolve,
    persistableCampView,
  });
}

export function createFixtureSecretsAdapter({ provider, store }) {
  const providerName = requireString(provider, "provider");
  const entries = requirePlainObject(store, "store");
  const reads = [];

  return Object.freeze({
    provider: providerName,
    reads,
    async readSecret(input) {
      const path = requireString(input?.path, "secret read path");
      if (!Object.hasOwn(entries, path)) {
        throw new Error(`fixture secret ${path} is not present`);
      }
      reads.push({
        campId: input.campId,
        credentialRef: input.credentialRef,
        path,
        provider: providerName,
        secretRef: input.secretRef,
        tokenUsageId: input.tokenUsageId,
      });
      return { value: entries[path] };
    },
  });
}

export function assertNoPlaintextConformance(surfaces, secretValues) {
  const secrets = [...new Set((secretValues ?? []).filter((value) => value !== undefined && value !== null).map(String))]
    .filter((value) => value.length > 0);
  const leaks = [];

  for (const [name, surface] of Object.entries({
    bindle: surfaces?.bindle,
    camp: surfaces?.camp,
    events: surfaces?.events,
    logs: surfaces?.logs,
    spans: surfaces?.spans,
  })) {
    const serialized = serializeSurface(surface);
    for (const secret of secrets) {
      if (serialized.includes(secret)) {
        leaks.push(`${name} contains plaintext secret`);
      }
    }
  }

  if (leaks.length > 0) {
    throw new Error(`no-plaintext conformance failed: ${[...new Set(leaks)].join("; ")}`);
  }

  return deepFreeze({ ok: true });
}

export function persistableCampView(camp) {
  const normalized = requirePlainObject(camp, "camp");
  return deepFreeze({
    id: requireString(normalized.id, "camp.id"),
    bindings: mapRecords(normalized.bindings, (binding) => ({
      action: binding.action,
      port: binding.port,
      provider: binding.provider,
      resource: binding.resource,
    })),
    config: clone(normalized.config ?? {}),
    secretRefs: mapRecords(normalized.secretRefs, (declaration) => ({
      federation: declaration.federation === true,
      path: declaration.path,
      provider: declaration.provider,
      staticHatch: declaration.staticHatch ? clone(declaration.staticHatch) : undefined,
    })),
  });
}

function normalizeResolutionInput(key, entry, context) {
  const normalizedEntry = requirePlainObject(entry, "entry");
  if (!normalizedEntry.source?.kind) {
    throw new Error(`config entry ${key} is missing source.kind`);
  }

  return {
    key: requireString(key, "config key"),
    entry: normalizedEntry,
    camp: requirePlainObject(context?.camp, "camp"),
    subject: requirePlainObject(context?.subject, "subject"),
    svid: requirePlainObject(context?.svid, "svid"),
  };
}

function normalizeScope(input, field) {
  const record = requirePlainObject(input, field);
  return {
    port: requireString(record.port, `${field}.port`),
    resource: requireString(record.resource, `${field}.resource`),
    action: requireString(record.action, `${field}.action`),
  };
}

function normalizeSecretsAdapters(adapters) {
  const normalized = new Map();
  for (const [provider, adapter] of Object.entries(requirePlainObject(adapters, "secrets"))) {
    if (!adapter || !(adapter.readSecret instanceof Function)) {
      throw new Error(`secrets adapter ${provider} must implement readSecret(input)`);
    }
    normalized.set(provider, adapter);
  }
  return normalized;
}

function normalizeSecretRead(read, ref) {
  if (!read || !Object.hasOwn(read, "value")) {
    throw new Error(`secrets adapter did not return a value for ${ref}`);
  }
  return read.value;
}

function requireSecretsAdapter(adapters, provider) {
  const providerName = requireString(provider, "provider");
  const adapter = adapters.get(providerName);
  if (!adapter) {
    throw new Error(`no secrets adapter registered for provider ${providerName}`);
  }
  return adapter;
}

function requireCampRecord(records, ref, label) {
  const collection = requirePlainObject(records, `camp.${label}s`);
  if (!Object.hasOwn(collection, ref)) {
    throw new Error(`camp ${label} ${ref} is not declared`);
  }
  return requirePlainObject(collection[ref], `camp.${labels(label)}.${ref}`);
}

function labels(label) {
  return label === "secretRef" ? "secretRefs" : `${label}s`;
}

function requireTokenBroker(tokenBroker) {
  if (!tokenBroker || !(tokenBroker.requestToken instanceof Function)) {
    throw new Error("secretless config resolver requires tokenBroker.requestToken(input)");
  }
  return tokenBroker;
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function mapRecords(records, mapper) {
  return Object.fromEntries(
    Object.entries(records ?? {}).map(([key, value]) => {
      const mapped = mapper(value);
      return [
        key,
        Object.fromEntries(Object.entries(mapped).filter(([, entryValue]) => entryValue !== undefined)),
      ];
    }),
  );
}

function serializeSurface(surface) {
  if (surface === undefined || surface === null) {
    return "";
  }
  if (isJsonString(surface)) {
    return surface;
  }
  return JSON.stringify(surface);
}

function defaultIdFactory() {
  let next = 1;
  return (prefix) => `${prefix}-${next++}`;
}

function isPlainObject(value) {
  return (
    value !== null &&
    isJsonObject(value) &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
