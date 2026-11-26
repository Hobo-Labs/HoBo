import { isJsonString, isJsonObject } from "./json.js";
const MANIFEST_SCHEMA = "hobo.manifest/v1";
const RESOURCE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const MANIFEST_REFERENCE = /^\{([A-Za-z][A-Za-z0-9_-]*)\.([A-Za-z][A-Za-z0-9_.-]*)\}$/;

export class BindReferenceError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = "BindReferenceError";
    this.path = path;
  }
}

export function data(name, options = {}) {
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

export function service(name, options = {}) {
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

export function addContainer(name, source, options = {}) {
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
    const name = endpoint.name ?? "http";
    handle.endpoints[name] = {
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

  handle.withVolume = (name, target) => {
    handle.annotations.volumes ??= [];
    handle.annotations.volumes.push({ name, target });
    return handle;
  };

  handle.withHttpHealthCheck = (path) => {
    handle.annotations.health = { type: "http", path };
    return handle;
  };

  handle.withHttpEndpoint = (port, options = {}) =>
    handle.withEndpoint({
      name: options.name ?? "http",
      scheme: "http",
      port,
      targetPort: options.targetPort,
      external: options.external,
      protocol: options.protocol,
    });

  handle.withArgs = (...args) => {
    handle.annotations.args ??= [];
    handle.annotations.args.push(...args.flat());
    return handle;
  };

  handle.withBindMount = (source, target, readOnly = false) => {
    handle.annotations.bindMounts ??= [];
    handle.annotations.bindMounts.push({ source, target, readOnly });
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

export function bindingTypesFor(handle) {
  assertComponent(handle, "bindingTypesFor.handle");
  return Object.fromEntries(
    Object.entries(handle.bindings).map(([name, binding]) => [
      name,
      binding.clientType,
    ]),
  );
}

export function compileBindleManifest(handles) {
  const resources = {};
  const entries = [];

  for (const handle of handles) {
    assertHandle(handle);
    if (resources[handle.name]) {
      throw new BindReferenceError(
        `resources.${handle.name}`,
        "duplicate resource id",
      );
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

function componentHandle(kind, name, options) {
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

  const handle = {
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
      const links = [];

      for (const [alias, target] of Object.entries(bind)) {
        links.push({ import: target.port, to: target.name });
        env[`ConnectionStrings__${alias}`] = `{${target.name}.connectionString}`;
      }

      const resource = {
        type: "component.v1",
        runtime: "wasm",
        exports: ["wasi:http/incoming-handler"],
        links,
        env,
        bindings,
      };

      if (options.image) {
        resource.image = options.image;
      }
      if (options.build) {
        resource.build = options.build;
      }
      if (Object.keys(this.endpoints).length > 0) {
        resource.endpoints = this.endpoints;
      }
      if (Object.keys(this.annotations).length > 0) {
        resource.annotations = this.annotations;
      }

      return resource;
    },
  };

  return handle;
}

function recordWait(handle, ownerName, key, dependency, until) {
  const target = resolveDependencyName(dependency);
  if (!isJsonString(target) || !RESOURCE_ID.test(target)) {
    throw new BindReferenceError(
      `resources.${ownerName}.${key}`,
      "must reference a declared resource handle or id",
    );
  }
  handle.annotations[key] ??= [];
  handle.annotations[key].push({ to: target, until });
}

function resolveDependencyName(dependency) {
  if (isJsonString(dependency)) {
    return dependency;
  }
  if (isRecord(dependency) && isJsonString(dependency.name)) {
    return dependency.name;
  }
  return null;
}

function normalizeBindMap(bind = {}) {
  if (!isRecord(bind)) {
    throw new BindReferenceError("bind", "must be a resource map");
  }

  for (const [alias, target] of Object.entries(bind)) {
    assertResourceName(alias, `bind.${alias}`);
    if (!target || target.kind !== "resource") {
      throw new BindReferenceError(
        `bind.${alias}`,
        "must reference a declared resource handle",
      );
    }
  }

  return bind;
}

function renderCtxBindings(bind) {
  return Object.entries(bind)
    .map(([alias, target]) => `readonly ${alias}: ${target.clientType};`)
    .join("\n");
}

function validateLinks(handle, resources) {
  const links = resources[handle.name].links ?? [];

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

function validateLazyReferences(resourceId, resource, resources) {
  visitStrings(resource, `resources.${resourceId}`, (value, path) => {
    const match = MANIFEST_REFERENCE.exec(value);
    if (!match) {
      return;
    }

    const referencedResource = match[1];
    if (!resources[referencedResource]) {
      throw new BindReferenceError(
        path,
        `unknown resource ${referencedResource}`,
      );
    }
  });
}

function visitStrings(value, path, visitor) {
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

function assertHandle(handle) {
  if (
    !handle ||
    !["resource", "service", "container"].includes(handle.kind) ||
    !isJsonString(handle.name) ||
    !(handle.manifest instanceof Function)
  ) {
    throw new BindReferenceError("handles", "must contain HoBo resource handles");
  }
}

function assertComponent(handle, path) {
  if (!handle || !["service", "container"].includes(handle.kind)) {
    throw new BindReferenceError(path, "must be a service or container handle");
  }
}

function assertResourceName(name, path) {
  if (!isJsonString(name) || !RESOURCE_ID.test(name)) {
    throw new BindReferenceError(path, "invalid resource id");
  }
}

function isRecord(value) {
  return isJsonObject(value) && value !== null && !Array.isArray(value);
}
