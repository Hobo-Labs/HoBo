import {
  MembraneOverloadedError,
  MembraneSeveredError,
} from "../../wrpc-membrane-failure-contract/src/wrpc-membrane-failure.js";
import { isJsonString, isJsonObject } from "./json.js";


export const LATTICE_TRANSPORT_CONTRACT_VERSION = "hobo.wrpc.lattice-transport/v1";

export function createLatticeTransportContract({ codec = createJsonWitCodec() } = {}) {
  return new LatticeTransportContract({ codec });
}

export function createJsonWitCodec() {
  return Object.freeze({
    name: "json-wit",
    encode(value) {
      return structuredClone(value);
    },
    decode(value) {
      return structuredClone(value);
    },
  });
}

export async function runLatticeTransportConformance() {
  const assertions = {
    identicalCoLocatedAndCrossHostBehavior: (await provesIdenticalBehavior())
      ? "pass"
      : "fail",
    crossHostLinkResolution: (await provesCrossHostResolution()) ? "pass" : "fail",
    crossProcessLinkResolution: (await provesCrossProcessResolution()) ? "pass" : "fail",
    midStreamPartitionPartialFailure: (await provesMidStreamPartition()) ? "pass" : "fail",
    jetStreamFlowControlBackpressure: (await provesFlowControlBackpressure())
      ? "pass"
      : "fail",
  };

  return Object.freeze({
    schema: LATTICE_TRANSPORT_CONTRACT_VERSION,
    issue: "HOBO-27",
    refs: Object.freeze([
      "docs/design/wasm-runtime-wit.md#plan-20",
      "docs/design/adr/01-architecture-core.md#adr-0031",
      "docs/design/adr/01-architecture-core.md#adr-0069",
    ]),
    supportedTransports: Object.freeze(["in-process", "nats-jetstream-lattice"]),
    assertions: Object.freeze(assertions),
    nonCoveredDivergences: Object.freeze([
      "host-specific partial-failure timing",
      "wall-clock scheduling jitter across hosts",
    ]),
    scopeIn: Object.freeze([
      "NATS/JetStream wRPC transport behind the call abstraction",
      "co-located, cross-process, and cross-host link resolution through the same WIT contract",
      "late-bound link table entries carried over the lattice",
      "JetStream flow-control mapped to membrane backpressure",
    ]),
    scopeOut: Object.freeze([
      "wasmcloud-operator or Kubernetes packaging",
      "lattice link-migration host-.with()",
      "provider-native or SpinKube adapters",
    ]),
  });
}

class LatticeTransportContract {
  #hosts = new Map();
  #components = new Map();
  #providers = new Map();
  #links = new Map();
  #partitionedHosts = new Set();

  constructor({ codec }) {
    this.codec = codec;
    this.events = [];
  }

  registerHost(host) {
    const id = requireNonEmptyString(host?.id, "host.id");
    this.#hosts.set(id, {
      id,
      lattice: host.lattice ?? "hobo-default",
    });
    this.events.push({
      type: "lattice.HostJoined",
      broker: "nats/jetstream",
      hostId: id,
      lattice: host.lattice ?? "hobo-default",
    });
  }

  registerComponent(component) {
    const id = requireNonEmptyString(component?.id, "component.id");
    const hostId = requireNonEmptyString(component?.hostId, "component.hostId");
    this.#requireHost(hostId);
    this.#components.set(id, {
      id,
      hostId,
      processId: component.processId ?? null,
      imports: new Set(component.imports ?? []),
    });
  }

  registerProvider(provider) {
    const id = requireNonEmptyString(provider?.id, "provider.id");
    const hostId = requireNonEmptyString(provider?.hostId, "provider.hostId");
    this.#requireHost(hostId);
    if (!provider.exports || !isJsonObject(provider.exports)) {
      throw new TypeError("provider.exports must be an object");
    }

    this.#providers.set(id, {
      id,
      hostId,
      processId: provider.processId ?? null,
      exports: provider.exports,
      maxInFlight: normalizeNonNegativeInteger(provider.maxInFlight ?? 32, "provider.maxInFlight"),
      inFlight: 0,
    });
  }

  link({ componentId, importInterface, providerId, exportInterface }) {
    const component = this.#requireComponent(componentId);
    const importedInterface = requireNonEmptyString(importInterface, "importInterface");
    if (!component.imports.has(importedInterface)) {
      throw new Error(`wrpc.import_not_declared: ${componentId}:${importedInterface}`);
    }

    const provider = this.#requireProvider(providerId);
    const exportedInterface = requireNonEmptyString(exportInterface, "exportInterface");
    if (!provider.exports[exportedInterface]) {
      throw new Error(`wrpc.export_not_found: ${providerId}:${exportedInterface}`);
    }

    const crossHost = component.hostId !== provider.hostId;
    const crossProcess = processIdentity(component) !== processIdentity(provider);
    const latticeTransport = crossHost || crossProcess;
    const link = Object.freeze({
      componentId,
      importInterface: importedInterface,
      callerHostId: component.hostId,
      callerProcessId: component.processId,
      providerId,
      exportInterface: exportedInterface,
      providerHostId: provider.hostId,
      providerProcessId: provider.processId,
      transport: latticeTransport ? "nats-jetstream-lattice" : "in-process",
      crossHost,
      crossProcess,
      boundaryMode: "live",
      lateBound: true,
      subject: latticeTransport
        ? latticeSubject(component.hostId, provider.hostId, providerId, exportedInterface)
        : null,
      jetStream: latticeTransport
        ? Object.freeze({
            stream: "hobo-wrpc-links",
            durableConsumer: durableConsumerName(componentId, importedInterface),
            flowControl: "explicit-ack",
          })
        : null,
    });
    this.#links.set(linkKey(componentId, importedInterface), link);
    this.events.push({ type: "link.Established", ...link });
    return link;
  }

  async callImport(componentId, importInterface, operation, payload = {}, options = {}) {
    this.#requireComponent(componentId);
    const link = this.#links.get(linkKey(componentId, importInterface));
    if (!link) {
      throw new Error(`wrpc.no_route: ${componentId}:${importInterface}`);
    }

    const provider = this.#requireProvider(link.providerId);
    const op = requireNonEmptyString(operation, "operation");
    const implementation = provider.exports?.[link.exportInterface]?.[op];
    if (!(implementation instanceof Function)) {
      throw new Error(`wrpc.operation_not_found: ${link.exportInterface}.${op}`);
    }

    return link.transport === "nats-jetstream-lattice"
      ? this.#callOverLattice({ link, provider, operation: op, payload, options, implementation })
      : this.#callInProcess({ link, provider, operation: op, payload, options, implementation });
  }

  partitionHost(hostId) {
    const id = requireNonEmptyString(hostId, "hostId");
    this.#requireHost(id);
    this.#partitionedHosts.add(id);
    this.events.push({
      type: "lattice.Partitioned",
      broker: "nats/jetstream",
      hostId: id,
    });
  }

  healHost(hostId) {
    const id = requireNonEmptyString(hostId, "hostId");
    this.#partitionedHosts.delete(id);
    this.events.push({
      type: "lattice.Healed",
      broker: "nats/jetstream",
      hostId: id,
    });
  }

  report() {
    return Object.freeze({
      schema: LATTICE_TRANSPORT_CONTRACT_VERSION,
      issue: "HOBO-27",
      lattice: Object.freeze({
        broker: "nats/jetstream",
        hosts: Object.freeze([...this.#hosts.keys()].sort()),
        partitionedHosts: Object.freeze([...this.#partitionedHosts].sort()),
        subjects: Object.freeze(
          [...this.#links.values()]
            .filter((link) => link.subject)
            .map((link) => link.subject)
            .sort(),
        ),
      }),
      links: Object.freeze([...this.#links.values()].map((link) => ({ ...link }))),
      supportedTransports: Object.freeze(["in-process", "nats-jetstream-lattice"]),
      events: Object.freeze(structuredClone(this.events)),
      nonCoveredDivergences: Object.freeze([
        "host-specific partial-failure timing",
        "wall-clock scheduling jitter across hosts",
      ]),
      scopeIn: Object.freeze([
        "NATS/JetStream wRPC transport behind the call abstraction",
        "co-located, cross-process, and cross-host link resolution through the same WIT contract",
        "late-bound link table entries carried over the lattice",
        "JetStream flow-control mapped to membrane backpressure",
      ]),
      scopeOut: Object.freeze([
        "wasmcloud-operator or Kubernetes packaging",
        "lattice link-migration host-.with()",
        "provider-native or SpinKube adapters",
      ]),
    });
  }

  async #callInProcess({ link, operation, payload, options, implementation }) {
    const encodedResult = await implementation(this.codec.encode(payload), {
      componentId: link.componentId,
      providerId: link.providerId,
      importInterface: link.importInterface,
      exportInterface: link.exportInterface,
      operation,
      transport: link.transport,
      idempotencyKey: options.idempotencyKey,
    });
    const result = this.codec.decode(encodedResult);
    this.events.push({
      type: "link.Called",
      componentId: link.componentId,
      importInterface: link.importInterface,
      providerId: link.providerId,
      exportInterface: link.exportInterface,
      operation,
      transport: link.transport,
      boundaryMode: link.boundaryMode,
      codec: this.codec.name,
    });
    return result;
  }

  async #callOverLattice({ link, provider, operation, payload, options, implementation }) {
    if (this.#isPartitioned(link.callerHostId, link.providerHostId)) {
      const error = createSeveredError({ link, operation, reason: "nats-partition-before-delivery" });
      this.events.push(toFailureEvent("link.Failed", link, operation, error));
      throw error;
    }

    if (provider.inFlight >= provider.maxInFlight) {
      const error = new MembraneOverloadedError({
        providerId: provider.id,
        operation,
        importInterface: link.importInterface,
        maxInFlight: provider.maxInFlight,
        inFlight: provider.inFlight,
      });
      this.events.push({
        type: "lattice.FlowControlled",
        broker: "nats/jetstream",
        stream: link.jetStream.stream,
        subject: link.subject,
        componentId: link.componentId,
        providerId: link.providerId,
        maxInFlight: provider.maxInFlight,
        inFlight: provider.inFlight,
        failureClass: error.failure.class,
      });
      this.events.push(toFailureEvent("link.Rejected", link, operation, error));
      throw error;
    }

    provider.inFlight += 1;
    this.events.push({
      type: "lattice.MessagePublished",
      broker: "nats/jetstream",
      stream: link.jetStream.stream,
      subject: link.subject,
      componentId: link.componentId,
      callerHostId: link.callerHostId,
      providerId: link.providerId,
      providerHostId: link.providerHostId,
      operation,
      flowControl: link.jetStream.flowControl,
    });
    this.events.push({
      type: "link.Called",
      componentId: link.componentId,
      importInterface: link.importInterface,
      providerId: link.providerId,
      exportInterface: link.exportInterface,
      operation,
      transport: link.transport,
      boundaryMode: link.boundaryMode,
      subject: link.subject,
      stream: link.jetStream.stream,
      codec: this.codec.name,
    });

    try {
      const encodedResult = await implementation(this.codec.encode(payload), {
        componentId: link.componentId,
        providerId: link.providerId,
        importInterface: link.importInterface,
        exportInterface: link.exportInterface,
        operation,
        transport: link.transport,
        subject: link.subject,
        idempotencyKey: options.idempotencyKey,
        severMidStream: ({ committed = "unknown" } = {}) => {
          this.partitionHost(link.providerHostId);
          throw createSeveredError({
            link,
            operation,
            committed,
            reason: "nats-partition-mid-stream",
          });
        },
      });
      const result = this.codec.decode(encodedResult);
      this.events.push({
        type: "lattice.MessageDelivered",
        broker: "nats/jetstream",
        stream: link.jetStream.stream,
        subject: link.subject,
        componentId: link.componentId,
        callerHostId: link.callerHostId,
        providerId: link.providerId,
        providerHostId: link.providerHostId,
        operation,
        ack: "explicit",
      });
      return result;
    } catch (error) {
      if (isMembraneTransportFailure(error)) {
        this.events.push(toFailureEvent("link.Failed", link, operation, error));
      }
      throw error;
    } finally {
      provider.inFlight -= 1;
    }
  }

  #isPartitioned(callerHostId, providerHostId) {
    return this.#partitionedHosts.has(callerHostId) || this.#partitionedHosts.has(providerHostId);
  }

  #requireHost(hostId) {
    const host = this.#hosts.get(hostId);
    if (!host) {
      throw new Error(`wrpc.host_not_registered: ${hostId}`);
    }
    return host;
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

async function provesIdenticalBehavior() {
  const lattice = createLatticeTransportContract();
  lattice.registerHost({ id: "host-a" });
  lattice.registerHost({ id: "host-b" });
  lattice.registerComponent({
    id: "cart-api",
    hostId: "host-a",
    imports: ["wasi:keyvalue/store"],
  });
  lattice.registerProvider(proofKvProvider({ id: "kv-local", hostId: "host-a" }));
  lattice.registerProvider(proofKvProvider({ id: "kv-remote", hostId: "host-b" }));
  lattice.link({
    componentId: "cart-api",
    importInterface: "wasi:keyvalue/store",
    providerId: "kv-local",
    exportInterface: "wasi:keyvalue/store",
  });
  const local = await lattice.callImport("cart-api", "wasi:keyvalue/store", "get", {
    key: "session",
  });
  lattice.link({
    componentId: "cart-api",
    importInterface: "wasi:keyvalue/store",
    providerId: "kv-remote",
    exportInterface: "wasi:keyvalue/store",
  });
  const remote = await lattice.callImport("cart-api", "wasi:keyvalue/store", "get", {
    key: "session",
  });
  return JSON.stringify(local) === JSON.stringify(remote);
}

async function provesCrossHostResolution() {
  const lattice = proofRemoteKvLattice();
  const link = lattice.link({
    componentId: "cart-api",
    importInterface: "wasi:keyvalue/store",
    providerId: "kv-remote",
    exportInterface: "wasi:keyvalue/store",
  });
  await lattice.callImport("cart-api", "wasi:keyvalue/store", "get", { key: "cart" });
  const eventTypes = lattice.report().events.map((event) => event.type);
  return (
    link.transport === "nats-jetstream-lattice" &&
    eventTypes.includes("lattice.MessagePublished") &&
    eventTypes.includes("lattice.MessageDelivered")
  );
}

async function provesCrossProcessResolution() {
  const lattice = createLatticeTransportContract();
  lattice.registerHost({ id: "host-a" });
  lattice.registerComponent({
    id: "cart-api",
    hostId: "host-a",
    processId: "api-process",
    imports: ["wasi:keyvalue/store"],
  });
  lattice.registerProvider({
    ...proofKvProvider({ id: "kv-sidecar", hostId: "host-a" }),
    processId: "provider-process",
  });
  const link = lattice.link({
    componentId: "cart-api",
    importInterface: "wasi:keyvalue/store",
    providerId: "kv-sidecar",
    exportInterface: "wasi:keyvalue/store",
  });
  await lattice.callImport("cart-api", "wasi:keyvalue/store", "get", {
    key: "same-host",
  });
  return link.transport === "nats-jetstream-lattice" && link.crossProcess && !link.crossHost;
}

async function provesMidStreamPartition() {
  const lattice = createLatticeTransportContract();
  lattice.registerHost({ id: "host-a" });
  lattice.registerHost({ id: "host-b" });
  lattice.registerComponent({
    id: "uploader",
    hostId: "host-a",
    imports: ["wasi:io/streams"],
  });
  lattice.registerProvider({
    id: "blob",
    hostId: "host-b",
    exports: {
      "wasi:io/streams": {
        write(_payload, context) {
          context.severMidStream({ committed: "unknown" });
        },
      },
    },
  });
  lattice.link({
    componentId: "uploader",
    importInterface: "wasi:io/streams",
    providerId: "blob",
    exportInterface: "wasi:io/streams",
  });

  try {
    await lattice.callImport("uploader", "wasi:io/streams", "write", {});
    return false;
  } catch (error) {
    return error instanceof MembraneSeveredError && error.failure.class === "partial-failure";
  }
}

async function provesFlowControlBackpressure() {
  let unblock;
  const slowCall = new Promise((resolve) => {
    unblock = resolve;
  });
  const lattice = createLatticeTransportContract();
  lattice.registerHost({ id: "host-a" });
  lattice.registerHost({ id: "host-b" });
  lattice.registerComponent({
    id: "writer",
    hostId: "host-a",
    imports: ["wasi:keyvalue/store"],
  });
  lattice.registerProvider({
    id: "kv-remote",
    hostId: "host-b",
    maxInFlight: 1,
    exports: {
      "wasi:keyvalue/store": {
        async set() {
          await slowCall;
          return { ok: true };
        },
      },
    },
  });
  lattice.link({
    componentId: "writer",
    importInterface: "wasi:keyvalue/store",
    providerId: "kv-remote",
    exportInterface: "wasi:keyvalue/store",
  });

  const first = lattice.callImport("writer", "wasi:keyvalue/store", "set", {});
  try {
    await lattice.callImport("writer", "wasi:keyvalue/store", "set", {});
    return false;
  } catch (error) {
    unblock();
    await first;
    return error instanceof MembraneOverloadedError && error.failure.class === "transient";
  }
}

function proofRemoteKvLattice() {
  const lattice = createLatticeTransportContract();
  lattice.registerHost({ id: "host-a" });
  lattice.registerHost({ id: "host-b" });
  lattice.registerComponent({
    id: "cart-api",
    hostId: "host-a",
    imports: ["wasi:keyvalue/store"],
  });
  lattice.registerProvider(proofKvProvider({ id: "kv-remote", hostId: "host-b" }));
  return lattice;
}

function proofKvProvider({ id, hostId }) {
  return {
    id,
    hostId,
    exports: {
      "wasi:keyvalue/store": {
        get(payload) {
          return { value: `stored:${payload.key}` };
        },
      },
    },
  };
}

function createSeveredError({
  link,
  operation,
  committed = "unknown",
  reason,
}) {
  const error = new MembraneSeveredError({
    providerId: link.providerId,
    operation,
    importInterface: link.importInterface,
    committed,
  });
  error.reason = reason;
  error.callerHostId = link.callerHostId;
  error.providerHostId = link.providerHostId;
  return error;
}

function toFailureEvent(type, link, operation, error) {
  return {
    type,
    broker: "nats/jetstream",
    stream: link.jetStream?.stream ?? null,
    subject: link.subject,
    componentId: link.componentId,
    importInterface: link.importInterface,
    providerId: link.providerId,
    providerHostId: link.providerHostId,
    operation,
    membrane: error.membrane,
    failureClass: error.failure?.class,
    reason: error.reason ?? error.code,
  };
}

function isMembraneTransportFailure(error) {
  return error instanceof MembraneSeveredError || error instanceof MembraneOverloadedError;
}

function latticeSubject(callerHostId, providerHostId, providerId, exportInterface) {
  return [
    "wrpc",
    "hobo",
    sanitizeSubjectSegment(callerHostId),
    sanitizeSubjectSegment(providerHostId),
    sanitizeSubjectSegment(providerId),
    sanitizeSubjectSegment(exportInterface),
  ].join(".");
}

function durableConsumerName(componentId, importInterface) {
  return `consumer.${sanitizeSubjectSegment(componentId)}.${sanitizeSubjectSegment(importInterface)}`;
}

function linkKey(componentId, importInterface) {
  return `${componentId}\0${importInterface}`;
}

function processIdentity(entity) {
  return entity.processId ?? "in-process";
}

function sanitizeSubjectSegment(value) {
  return requireNonEmptyString(value, "subject segment")
    .replace(/[^A-Za-z0-9_-]+/g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\./, "")
    .replace(/\.$/, "");
}

function normalizeNonNegativeInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative integer`);
  }
  return value;
}

function requireNonEmptyString(value, fieldName) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}
