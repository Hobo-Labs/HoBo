import { isJsonString } from "./json.js";
export class NoRouteError extends Error {
  constructor({ componentId, importInterface }) {
    const routeKey = linkKey(componentId, importInterface);
    super(`wrpc.no_route: ${componentId}:${importInterface}`);
    this.name = "NoRouteError";
    this.code = "no-route";
    this.componentId = componentId;
    this.importInterface = importInterface;
    this.routeKey = routeKey;
  }
}

export function createInProcessWrpcMembrane({ codec = createJsonWitCodec() } = {}) {
  return new InProcessWrpcMembrane(codec);
}

export function createJsonWitCodec() {
  return Object.freeze({
    name: "json-wit",
    encode(value) {
      return structuredClone(value);
    },
    decode(value) {
      return structuredClone(value);
    }
  });
}

class InProcessWrpcMembrane {
  #components = new Map();
  #providers = new Map();
  #links = new Map();

  constructor(codec) {
    if (!codec || !(codec.encode instanceof Function) || !(codec.decode instanceof Function)) {
      throw new Error("wrpc.codec_required");
    }
    this.codec = codec;
    this.events = [];
  }

  registerComponent(component) {
    assertId(component?.id, "component");
    this.#components.set(component.id, {
      id: component.id,
      imports: new Set(component.imports ?? [])
    });
  }

  registerProvider(provider) {
    assertId(provider?.id, "provider");
    this.#providers.set(provider.id, {
      id: provider.id,
      exports: provider.exports ?? {}
    });
  }

  link({ componentId, importInterface, providerId, exportInterface }) {
    const component = this.#requireComponent(componentId);
    if (!component.imports.has(importInterface)) {
      throw new Error(`wrpc.import_not_declared: ${componentId}:${importInterface}`);
    }

    const provider = this.#requireProvider(providerId);
    if (!provider.exports[exportInterface]) {
      throw new Error(`wrpc.export_not_found: ${providerId}:${exportInterface}`);
    }

    const link = Object.freeze({
      componentId,
      importInterface,
      providerId,
      exportInterface,
      transport: "in-process",
      boundaryMode: "live"
    });
    this.#links.set(linkKey(componentId, importInterface), link);
    this.events.push({ type: "link.Established", ...link });
    return link;
  }

  async callImport(componentId, importInterface, operation, payload = {}, options = {}) {
    this.#requireComponent(componentId);
    const link = this.#links.get(linkKey(componentId, importInterface));
    if (!link) {
      throw new NoRouteError({ componentId, importInterface });
    }

    const provider = this.#requireProvider(link.providerId);
    const implementation = provider.exports?.[link.exportInterface]?.[operation];
    if (!(implementation instanceof Function)) {
      throw new Error(`wrpc.operation_not_found: ${link.exportInterface}.${operation}`);
    }

    const encodedPayload = this.codec.encode(payload);
    const encodedResult = await implementation(encodedPayload, {
      componentId,
      importInterface,
      operation,
      deadline: options.deadline ?? null
    });
    const result = this.codec.decode(encodedResult);

    this.events.push({
      type: "link.Called",
      componentId,
      importInterface,
      providerId: link.providerId,
      exportInterface: link.exportInterface,
      operation,
      boundaryMode: link.boundaryMode,
      transport: link.transport,
      deadline: options.deadline ?? null,
      codec: this.codec.name
    });
    return result;
  }

  report() {
    return {
      schema: "hobo.wrpc.in-process-link/v1",
      issue: "HOBO-18",
      supportedTransports: ["in-process"],
      boundaryModeDefault: "live",
      events: ["link.Established", "link.Called"],
      scopeIn: [
        "WIT-shaped encode-route-decode call abstraction",
        "link table import-to-provider-export routing",
        "typed no-route error for missing links",
        "link.Called event with deadline field present"
      ],
      scopeOut: [
        "NATS/JetStream lattice transport",
        "deadline enforcement",
        "backpressure handling",
        "partial or ambiguous failure taxonomy",
        "wire-version negotiation"
      ]
    };
  }

  #requireComponent(componentId) {
    const component = this.#components.get(componentId);
    if (!component) {
      throw new Error(`wrpc.component_not_registered: ${componentId}`);
    }
    return component;
  }

  #requireProvider(providerId) {
    const provider = this.#providers.get(providerId);
    if (!provider) {
      throw new Error(`wrpc.provider_not_registered: ${providerId}`);
    }
    return provider;
  }
}

function linkKey(componentId, importInterface) {
  return `${componentId}\0${importInterface}`;
}

function assertId(id, kind) {
  if (!isJsonString(id) || id.length === 0) {
    throw new Error(`wrpc.${kind}_id_required`);
  }
}
