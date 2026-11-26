import { isJsonString } from "./json.js";
const HTTP_INCOMING = "wasi:http/incoming-handler@0.2.0";

export class ComponentTrapError extends Error {
  constructor(componentId, cause) {
    super(`component_host.component_trapped: ${componentId}: ${cause.message}`);
    this.name = "ComponentTrapError";
    this.componentId = componentId;
    this.cause = cause;
  }
}

export function createWasmtimeEngineStub({ version = "wasmtime-stub/0.1.0" } = {}) {
  return Object.freeze({
    kind: "wasmtime",
    version,
    instantiate(component) {
      return {
        id: component.id,
        imports: [...(component.imports ?? [])],
        exports: component.exports ?? {},
      };
    },
  });
}

export function createRuntimeLocalComponentHost({ engine = createWasmtimeEngineStub() } = {}) {
  return new RuntimeLocalComponentHost(engine);
}

class RuntimeLocalComponentHost {
  #components = new Map();
  #providers = new Map();
  #links = new Map();
  #leases = new Map();
  #lifecycle = new Map();

  constructor(engine) {
    if (engine?.kind !== "wasmtime") {
      throw new Error("component_host.engine_required: wasmtime");
    }
    this.engine = engine;
    this.events = [];
  }

  registerProvider(provider) {
    assertId(provider?.id, "provider");
    this.#providers.set(provider.id, {
      id: provider.id,
      exports: provider.exports ?? {},
    });
  }

  loadComponent(component) {
    assertId(component?.id, "component");
    const instance = this.engine.instantiate(component);
    this.#components.set(component.id, instance);
    this.#lifecycle.set(component.id, { id: component.id, state: "loaded" });
    this.#leases.set(component.id, [...(component.leases ?? [])]);
    this.events.push({ type: "component.Loaded", componentId: component.id, engine: this.engine.kind });
    return instance;
  }

  link({ componentId, importInterface, providerId, exportInterface }) {
    this.#requireLoaded(componentId);
    const provider = this.#providers.get(providerId);
    if (!provider) {
      throw new Error(`component_host.provider_not_registered: ${providerId}`);
    }
    if (!this.#components.get(componentId).imports.includes(importInterface)) {
      throw new Error(`component_host.import_not_declared: ${componentId}:${importInterface}`);
    }
    if (!provider.exports[exportInterface]) {
      throw new Error(`component_host.export_not_found: ${providerId}:${exportInterface}`);
    }

    const link = Object.freeze({
      componentId,
      importInterface,
      providerId,
      exportInterface,
      boundaryMode: "in-process",
    });
    this.#links.set(linkKey(componentId, importInterface), link);
    this.events.push({ type: "link.Established", ...link });
    return link;
  }

  invokeLinkedImport(componentId, importInterface, operation, payload) {
    this.#requireLoaded(componentId);
    const link = this.#links.get(linkKey(componentId, importInterface));
    if (!link) {
      throw new Error(`component_host.no_route: ${componentId}:${importInterface}`);
    }
    const provider = this.#providers.get(link.providerId);
    const implementation = provider?.exports?.[link.exportInterface]?.[operation];
    if (!(implementation instanceof Function)) {
      throw new Error(`component_host.operation_not_found: ${link.exportInterface}.${operation}`);
    }

    this.events.push({
      type: "link.Called",
      componentId,
      importInterface,
      providerId: link.providerId,
      exportInterface: link.exportInterface,
      operation,
      boundaryMode: link.boundaryMode,
    });
    return Promise.resolve(implementation(payload));
  }

  async handleHttp(componentId, request) {
    const component = this.#requireLoaded(componentId);
    const handler = component.exports?.[HTTP_INCOMING]?.handle;
    if (!(handler instanceof Function)) {
      throw new Error(`component_host.http_handler_missing: ${componentId}`);
    }

    try {
      const response = await handler(request, {
        callImport: (importInterface, operation, payload) =>
          this.invokeLinkedImport(componentId, importInterface, operation, payload),
      });
      this.events.push({ type: "component.Invoked", componentId, interface: HTTP_INCOMING, operation: "handle" });
      return response;
    } catch (error) {
      this.events.push({
        type: "component.Trapped",
        componentId,
        interface: HTTP_INCOMING,
        message: error.message,
      });
      throw new ComponentTrapError(componentId, error);
    }
  }

  async teardownComponent(componentId) {
    this.#requireLoaded(componentId);
    for (const key of this.#links.keys()) {
      if (key.startsWith(`${componentId}\0`)) {
        this.#links.delete(key);
      }
    }
    this.#leases.delete(componentId);
    this.#components.delete(componentId);
    this.#lifecycle.set(componentId, { id: componentId, state: "torn-down" });
    this.events.push({ type: "component.TornDown", componentId });
  }

  lifecycle(componentId) {
    return this.#lifecycle.get(componentId) ?? { id: componentId, state: "missing" };
  }

  activeLeases() {
    return [...this.#leases.values()].flat();
  }

  linkTable() {
    return [...this.#links.values()];
  }

  report() {
    return {
      schema: "hobo.component-host.runtime-local/v1",
      hostKind: "runtime-local",
      engine: "wasmtime",
      supportedBoundaryModes: ["in-process"],
      scopeIn: [
        "component lifecycle",
        "static link table",
        "wasi:http incoming-handler demo",
        "trap isolation",
        "clean teardown",
      ],
      scopeOut: [
        "cross-process lattice transport",
        "container packaging",
        "deny-by-default grant inference",
        "deterministic-clock replay",
      ],
      followUps: ["fuel/epoch execution limits"],
    };
  }

  #requireLoaded(componentId) {
    const component = this.#components.get(componentId);
    if (!component) {
      throw new Error(`component_host.component_not_loaded: ${componentId}`);
    }
    return component;
  }
}

function linkKey(componentId, importInterface) {
  return `${componentId}\0${importInterface}`;
}

function assertId(id, kind) {
  if (!isJsonString(id) || id.length === 0) {
    throw new Error(`component_host.${kind}_id_required`);
  }
}
