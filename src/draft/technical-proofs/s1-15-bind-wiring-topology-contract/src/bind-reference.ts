import {
  LAZY_TOKEN_PATTERN,
  MANIFEST_SCHEMA,
  RESOURCE_ID_PATTERN,
  type BindingMeta,
  type HoboManifest,
  type ManifestResource,
  parseResourceId,
} from "./types.js";
import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";


export class BindReferenceError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "BindReferenceError";
    this.path = path;
  }
}

export interface ResourceHandle {
  readonly kind: "resource";
  readonly name: string;
  readonly type: string;
  readonly port: string;
  readonly clientType: string;
  manifest(): ManifestResource;
}

export interface ComponentHandle {
  readonly kind: "service" | "container";
  readonly name: string;
  readonly bindings: Readonly<Record<string, BindingMeta>>;
  readonly env: Record<string, string>;
  readonly endpoints: JsonObject;
  readonly annotations: JsonObject;
  readonly typescript: { readonly ctxBindings: string };
  binding(alias: string): BindingMeta;
  manifest(): ManifestResource;
  withEndpoint?(endpoint: EndpointSpec): ComponentHandle;
  withEnvironment?(key: string, value: string): ComponentHandle;
  withVolume?(name: string, target: string): ComponentHandle;
  withHttpHealthCheck?(path: string): ComponentHandle;
  withHttpEndpoint?(
    port: number,
    options?: { name?: string; targetPort?: number; external?: boolean; protocol?: string },
  ): ComponentHandle;
  withArgs?(...args: readonly (string | readonly string[])[]): ComponentHandle;
  withBindMount?(source: string, target: string, readOnly?: boolean): ComponentHandle;
  withLifetime?(lifetime: "session" | "persistent"): ComponentHandle;
  waitFor?(dependency: DependencyRef): ComponentHandle;
  waitForCompletion?(dependency: DependencyRef): ComponentHandle;
  withDnsRecord?(): never;
}

export type Handle = ResourceHandle | ComponentHandle;
type DependencyRef = string | { readonly name: string };
type EndpointSpec = {
  readonly name?: string;
  readonly scheme: string;
  readonly port: number;
  readonly targetPort?: number;
  readonly external?: boolean;
  readonly protocol?: string;
};

export function data(
  name: string,
  options: { paradigm?: string } = {},
): ResourceHandle {
  assertResourceName(name, "data.name");

  return {
    kind: "resource",
    name,
    type: "data.v1",
    port: "hobo:data",
    clientType: "DataClient",
    manifest() {
      return {
        type: "data.v1",
        port: "hobo:data",
        paradigm: options.paradigm ?? "relational",
        connectionString: `{${name}.connectionString}`,
      };
    },
  };
}

export function service(
  name: string,
  options: {
    image?: string;
    bind?: Readonly<Record<string, ResourceHandle>>;
    env?: Readonly<Record<string, string>>;
    camp?: string;
  } = {},
): ComponentHandle {
  if (options.camp !== undefined) {
    throw new BindReferenceError(
      `resources.${name}.camp`,
      "cross-Camp placement is resolved by enclosing scopes",
    );
  }

  return componentHandle("service", name, {
    image: options.image,
    bind: options.bind,
    env: options.env,
  });
}

export function addContainer(
  name: string,
  source: string,
  options: {
    bind?: Readonly<Record<string, ResourceHandle>>;
    env?: Readonly<Record<string, string>>;
  } = {},
): ComponentHandle {
  const handle = componentHandle("container", name, {
    image: source,
    bind: options.bind,
    env: options.env,
    build: {
      provider: "hobo:build",
      source,
      defaultArtifact: "wasm-on-oci",
    },
  });

  handle.withEndpoint = (endpoint) => {
    const endpointName = endpoint.name ?? "http";
    handle.endpoints[endpointName] = {
      scheme: endpoint.scheme,
      port: endpoint.port,
      targetPort: endpoint.targetPort ?? endpoint.port,
      external: endpoint.external ?? false,
      protocol: endpoint.protocol ?? "tcp",
    };
    return handle;
  };

  handle.withEnvironment = (key, value) => {
    handle.env[key] = value;
    return handle;
  };

  handle.withVolume = (volumeName, target) => {
    // SAFETY: assertion to `const volumes = (handle.annotations.volumes as unknown[] | undefined) ?? [];` is required at this boundary.
    const volumes = (handle.annotations.volumes as unknown[] | undefined) ?? [];
    volumes.push({ name: volumeName, target });
    handle.annotations.volumes = volumes;
    return handle;
  };

  handle.withHttpHealthCheck = (path) => {
    handle.annotations.health = { type: "http", path };
    return handle;
  };

  handle.withHttpEndpoint = (port, endpointOptions = {}) =>
    handle.withEndpoint!({
      name: endpointOptions.name ?? "http",
      scheme: "http",
      port,
      targetPort: endpointOptions.targetPort,
      external: endpointOptions.external,
      protocol: endpointOptions.protocol,
    });

  handle.withArgs = (...args) => {
    // SAFETY: assertion to `const flat = (handle.annotations.args as unknown[] | undefined) ?? [];` is required at this boundary.
    const flat = (handle.annotations.args as unknown[] | undefined) ?? [];
    handle.annotations.args = [...flat, ...args.flat()];
    return handle;
  };

  handle.withBindMount = (mountSource, target, readOnly = false) => {
    // SAFETY: assertion to `const mounts = (handle.annotations.bindMounts as unknown[] | undefined) ?? [];` is required at this boundary.
    const mounts = (handle.annotations.bindMounts as unknown[] | undefined) ?? [];
    mounts.push({ source: mountSource, target, readOnly });
    handle.annotations.bindMounts = mounts;
    return handle;
  };

  handle.withLifetime = (lifetime) => {
    if (!["session", "persistent"].includes(lifetime)) {
      throw new BindReferenceError(
        `resources.${name}.lifetime`,
        "lifetime must be one of session, persistent",
      );
    }
    handle.annotations.lifetime = lifetime;
    return handle;
  };

  handle.waitFor = (dependency) => {
    recordWait(handle, name, "waitFor", dependency, "ready");
    return handle;
  };

  handle.waitForCompletion = (dependency) => {
    recordWait(handle, name, "waitForCompletion", dependency, "completed");
    return handle;
  };

  handle.withDnsRecord = () => {
    throw new BindReferenceError(
      `resources.${name}.dns`,
      "DNS is Yard-level and outside the bind reference contract",
    );
  };

  return handle;
}

export function bindingTypesFor(handle: ComponentHandle): Readonly<Record<string, string>> {
  assertComponent(handle, "bindingTypesFor.handle");
  return Object.fromEntries(
    Object.entries(handle.bindings).map(([alias, binding]) => [alias, binding.clientType]),
  );
}

export function compileBindleManifest(handles: readonly Handle[]): HoboManifest {
  const resources: Record<string, ManifestResource> = {};
  const entries: Handle[] = [];

  for (const handle of handles) {
    assertHandle(handle);
    if (resources[handle.name]) {
      throw new BindReferenceError(`resources.${handle.name}`, "duplicate resource id");
    }
    resources[handle.name] = handle.manifest();
    entries.push(handle);
  }

  for (const handle of entries) {
    if (handle.kind === "service" || handle.kind === "container") {
      validateLinks(handle, resources);
    }
  }

  for (const [id, resource] of Object.entries(resources)) {
    validateLazyReferences(id, resource, resources);
  }

  return {
    schema: MANIFEST_SCHEMA,
    resources,
  };
}

function componentHandle(
  kind: "service" | "container",
  name: string,
  options: {
    image?: string;
    bind?: Readonly<Record<string, ResourceHandle>>;
    env?: Readonly<Record<string, string>>;
    build?: Readonly<JsonObject>;
  },
): ComponentHandle {
  assertResourceName(name, `${kind}.name`);

  const bind = normalizeBindMap(options.bind);
  const bindings = Object.fromEntries(
    Object.entries(bind).map(([alias, target]) => [
      alias,
      {
        port: target.port,
        resource: target.name,
        clientType: target.clientType,
      },
    ]),
  );

  const handle: ComponentHandle = {
    kind,
    name,
    bindings,
    env: { ...options.env },
    endpoints: {},
    annotations: {},
    typescript: {
      ctxBindings: renderCtxBindings(bind),
    },
    binding(alias) {
      const found = bindings[alias];
      if (!found) {
        throw new BindReferenceError(
          `resources.${name}.bindings.${alias}`,
          `ctx.bindings.${alias} is not declared on service ${name}`,
        );
      }
      return found;
    },
    manifest() {
      const env = { ...this.env };
      const links: Array<{ import: string; to: string }> = [];

      for (const [alias, target] of Object.entries(bind)) {
        links.push({ import: target.port, to: target.name });
        env[`ConnectionStrings__${alias}`] = `{${target.name}.connectionString}`;
      }

      const resource: ManifestResource = {
        type: "component.v1",
        runtime: "wasm",
        exports: ["wasi:http/incoming-handler"],
        links,
        env,
        bindings,
      };

      if (options.image) {
        Object.assign(resource, { image: options.image });
      }
      if (options.build) {
        Object.assign(resource, { build: options.build });
      }
      if (Object.keys(this.endpoints).length > 0) {
        Object.assign(resource, { endpoints: { ...this.endpoints } });
      }
      if (Object.keys(this.annotations).length > 0) {
        Object.assign(resource, { annotations: { ...this.annotations } });
      }

      return resource;
    },
  };

  return handle;
}

function recordWait(
  handle: ComponentHandle,
  ownerName: string,
  key: string,
  dependency: DependencyRef,
  until: "ready" | "completed",
): void {
  const target = resolveDependencyName(dependency);
  if (!isJsonString(target) || !RESOURCE_ID_PATTERN.test(target)) {
    throw new BindReferenceError(
      `resources.${ownerName}.${key}`,
      "must reference a declared resource handle or id",
    );
  }
  // SAFETY: assertion to `const waits = (handle.annotations[key] as unknown[] | undefined) ?? [];` is required at this boundary.
  const waits = (handle.annotations[key] as unknown[] | undefined) ?? [];
  waits.push({ to: target, until });
  handle.annotations[key] = waits;
}

function resolveDependencyName(dependency: DependencyRef): string | null {
  if (isJsonString(dependency)) {
    return dependency;
  }
  if (isRecord(dependency) && isJsonString(dependency.name)) {
    return dependency.name;
  }
  return null;
}

function normalizeBindMap(
  bind: Readonly<Record<string, ResourceHandle>> = {},
): Readonly<Record<string, ResourceHandle>> {
  if (!isRecord(bind)) {
    throw new BindReferenceError("bind", "must be a resource map");
  }

  for (const [alias, target] of Object.entries(bind)) {
    assertResourceName(alias, `bind.${alias}`);
    if (!target || target.kind !== "resource") {
      throw new BindReferenceError(`bind.${alias}`, "must reference a declared resource handle");
    }
  }

  return bind;
}

function renderCtxBindings(bind: Readonly<Record<string, ResourceHandle>>): string {
  return Object.entries(bind)
    .map(([alias, target]) => `readonly ${alias}: ${target.clientType};`)
    .join("\n");
}

function validateLinks(
  handle: ComponentHandle,
  resources: Readonly<Record<string, ManifestResource>>,
): void {
  const links = resources[handle.name]?.links ?? [];

  links.forEach((link, index) => {
    const target = resources[link.to];
    if (!target) {
      throw new BindReferenceError(
        `resources.${handle.name}.links[${index}].to`,
        `unknown resource ${link.to}`,
      );
    }
    if (target.port !== link.import) {
      throw new BindReferenceError(
        `resources.${handle.name}.links[${index}].import`,
        `no matching declared resource for ${link.import}`,
      );
    }
  });
}

function validateLazyReferences(
  resourceId: string,
  resource: ManifestResource,
  resources: Readonly<Record<string, ManifestResource>>,
): void {
  visitStrings(resource, `resources.${resourceId}`, (value, path) => {
    const match = LAZY_TOKEN_PATTERN.exec(value);
    if (!match) {
      return;
    }

    const referencedResource = match[1]!;
    if (!resources[referencedResource]) {
      throw new BindReferenceError(path, `unknown resource ${referencedResource}`);
    }
  });
}

function visitStrings(
  value: JsonValue,
  path: string,
  visitor: (value: string, path: string) => void,
): void {
  if (isJsonString(value)) {
    visitor(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitStrings(item, `${path}[${index}]`, visitor));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      visitStrings(child, `${path}.${key}`, visitor);
    }
  }
}

function assertHandle(handle: JsonValue): asserts handle is Handle {
  if (
    !handle ||
    !isJsonObject(handle) ||
    !isJsonString(handle.kind) ||
    !["resource", "service", "container"].includes(handle.kind) ||
    !isJsonString(handle.name) ||
    !(handle.manifest instanceof Function)
  ) {
    throw new BindReferenceError("handles", "must contain HoBo resource handles");
  }
}

function assertComponent(handle: JsonValue, path: string): asserts handle is ComponentHandle {
  if (
    !handle ||
    !isJsonObject(handle) ||
    // SAFETY: assertion to `!["service", "container"].includes((handle as ComponentHandle).kind)` is required at this boundary.
    !["service", "container"].includes((handle as ComponentHandle).kind)
  ) {
    throw new BindReferenceError(path, "must be a service or container handle");
  }
}

function assertResourceName(name: string, path: string): void {
  if (!isJsonString(name) || !RESOURCE_ID_PATTERN.test(name)) {
    throw new BindReferenceError(path, "invalid resource id");
  }
  parseResourceId(name);
}

function isRecord(value: JsonValue): value is JsonObject {
  return isJsonObject(value) && value !== null && !Array.isArray(value);
}
