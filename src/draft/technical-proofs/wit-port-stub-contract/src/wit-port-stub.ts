import { isJsonString, isJsonNumber, isJsonObject } from "./json.js";
export const STUB_TRACE_SCHEMA = "hobo.stub.recorded-trace/v1";
export const STUB_REPLAY_HARNESS_SCHEMA = "hobo.stub.replay-harness/v1";
export const PAYMENTS_PORT = "hobo:payments/payments@0.1.0";

export class StubSchemaError extends Error {
  constructor({ operation, path, expected, actual }) {
    super(`stub.schema_invalid: ${operation} at ${path}`);
    this.name = "StubSchemaError";
    this.code = "stub.schema-invalid";
    this.operation = operation;
    this.path = path;
    this.expected = expected;
    this.actual = actual;
  }
}

export class ReplayDivergenceError extends Error {
  constructor({ index, functionName, field, expected, actual }) {
    super(`stub.replay_divergence: ${functionName}[${index}].${field}`);
    this.name = "ReplayDivergenceError";
    this.code = "stub.replay-divergence";
    this.index = index;
    this.functionName = functionName;
    this.field = field;
    this.expected = expected;
    this.actual = actual;
  }
}

export class NoRouteError extends Error {
  constructor({ componentId, importInterface }) {
    super(`stub.no_route: ${componentId}:${importInterface}`);
    this.name = "NoRouteError";
    this.code = "no-route";
    this.componentId = componentId;
    this.importInterface = importInterface;
  }
}

export function parseChargeInput(raw) {
  validateChargeInput(raw);
  return Object.freeze({
    amountCents: raw.amountCents,
    currency: raw.currency,
  });
}

export function parseChargeOutput(raw) {
  validateChargeOutput(raw);
  return Object.freeze({
    status: raw.status,
    transactionId: raw.transactionId,
  });
}

export function createPaymentsPortSchema() {
  return Object.freeze({
    wit: PAYMENTS_PORT,
    operations: Object.freeze({
      charge: {
        input: (value) => parseChargeInput(value),
        output: (value) => parseChargeOutput(value),
        defaultResponse: () => parseChargeOutput({ status: "ok", transactionId: "stub-txn-1" }),
      },
    }),
  });
}

export function createStubMembrane({ codec = createJsonWitCodec() } = {}) {
  return new StubMembrane(codec);
}

export function stub({
  membrane,
  componentId,
  portInterface,
  portSchema,
  providerId = `stub-${componentId}`,
  overrides = {},
}) {
  if (!membrane) {
    throw new TypeError("stub.membrane_required");
  }
  if (!portSchema?.operations) {
    throw new TypeError("stub.port_schema_required");
  }

  const exports = buildStubExports(portSchema, overrides, membrane);
  membrane.registerProvider({ id: providerId, exports: { [portInterface]: exports } });
  return membrane.link({
    componentId,
    importInterface: portInterface,
    providerId,
    exportInterface: portInterface,
    boundaryMode: "mock",
  });
}

export function exportRecordedTrace(membrane) {
  return {
    schema: STUB_TRACE_SCHEMA,
    entries: structuredClone(membrane.recordedTrace),
    events: membrane.events.filter((event) => event.type === "stub.Recorded"),
  };
}

export function replayRecordedTrace({ membrane, trace, adapter }) {
  const harness = createReplayHarness({ membrane, adapter });
  return harness.replay(trace);
}

export function createReplayHarness({ membrane, adapter }) {
  return {
  schema: STUB_REPLAY_HARNESS_SCHEMA,
  async replay(trace) {
    const entries = trace?.entries ?? trace ?? [];
    const failures = [];

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const functionName = entry.function;
      const handler = adapter?.[functionName];

      if (!(handler instanceof Function)) {
        failures.push({
          code: "replay.missing-handler",
          index,
          function: functionName,
        });
        continue;
      }

      const actual = await handler(structuredClone(entry.input));
      if (!deepEqual(entry.output, actual)) {
        failures.push({
          code: "stub.replay-divergence",
          index,
          function: functionName,
          field: "output",
          expected: entry.output,
          actual,
        });
      }
    }

    if (failures.length > 0) {
      const first = failures[0];
      throw new ReplayDivergenceError({
        index: first.index,
        functionName: first.function,
        field: first.field ?? "output",
        expected: first.expected,
        actual: first.actual,
      });
    }

    membrane?.events?.push({
      type: "stub.ReplayCompleted",
      entryCount: entries.length,
      deterministic: true,
    });

    return {
      ok: true,
      entryCount: entries.length,
      deterministic: true,
    };
  },
  };
}

function buildStubExports(portSchema, overrides, membrane) {
  const exports = {};

  for (const [operation, spec] of Object.entries(portSchema.operations)) {
    exports[operation] = async (input) => {
      spec.input(input);

      const override = overrides[operation];
      const output = override instanceof Function ? override(structuredClone(input)) : spec.defaultResponse(input);
      spec.output(output);

      const traceEntry = {
        function: operation,
        input: structuredClone(input),
        output: structuredClone(output),
      };

      membrane.recordedTrace.push(traceEntry);
      membrane.events.push({
        type: "stub.Recorded",
        port: portSchema.wit,
        operation,
        input: traceEntry.input,
        output: traceEntry.output,
        boundaryMode: "mock",
      });

      return output;
    };
  }

  return exports;
}

class StubMembrane {
  #components = new Map();
  #providers = new Map();
  #links = new Map();

  constructor(codec) {
    this.codec = codec;
    this.events = [];
    this.recordedTrace = [];
  }

  registerComponent(component) {
    assertId(component?.id, "component");
    this.#components.set(component.id, {
      id: component.id,
      imports: new Set(component.imports ?? []),
    });
  }

  registerProvider(provider) {
    assertId(provider?.id, "provider");
    this.#providers.set(provider.id, {
      id: provider.id,
      exports: provider.exports ?? {},
    });
  }

  link({ componentId, importInterface, providerId, exportInterface, boundaryMode = "live" }) {
    const component = this.#requireComponent(componentId);
    if (!component.imports.has(importInterface)) {
      throw new Error(`stub.import_not_declared: ${componentId}:${importInterface}`);
    }

    const provider = this.#requireProvider(providerId);
    if (!provider.exports[exportInterface]) {
      throw new Error(`stub.export_not_found: ${providerId}:${exportInterface}`);
    }

    const link = Object.freeze({
      componentId,
      importInterface,
      providerId,
      exportInterface,
      transport: "in-process",
      boundaryMode,
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
      throw new Error(`stub.operation_not_found: ${link.exportInterface}.${operation}`);
    }

    const encodedPayload = this.codec.encode(payload);
    const encodedResult = await implementation(encodedPayload, {
      componentId,
      importInterface,
      operation,
      deadline: options.deadline ?? null,
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
      codec: this.codec.name,
    });

    return result;
  }

  report() {
    return {
      schema: "hobo.stub.wit-port-stub/v1",
      issue: "HOBO-651",
      boundaryModes: ["live", "mock"],
      events: ["link.Established", "link.Called", "stub.Recorded", "stub.ReplayCompleted"],
      scopeIn: [
        "stub() links a typed mock provider behind any WIT port",
        "records calls as stub.Recorded events and replayable trace entries",
        "returns schema-valid canned responses with optional per-operation overrides",
        "replays recorded traces deterministically through the S1-12 harness stand-in",
      ],
      scopeOut: [
        "production packages/runtime promotion",
        "Camp event store persistence",
        "LLM-generated stub responses",
        "full WIT codegen from interface files",
      ],
    };
  }

  #requireComponent(componentId) {
    const component = this.#components.get(componentId);
    if (!component) {
      throw new Error(`stub.component_not_registered: ${componentId}`);
    }
    return component;
  }

  #requireProvider(providerId) {
    const provider = this.#providers.get(providerId);
    if (!provider) {
      throw new Error(`stub.provider_not_registered: ${providerId}`);
    }
    return provider;
  }
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

function validateChargeInput(input) {
  assertObject(input, "charge.input");
  if (!isJsonNumber(input.amountCents) || input.amountCents <= 0) {
    throw new StubSchemaError({
      operation: "charge",
      path: "amountCents",
      expected: "positive number",
      actual: input.amountCents,
    });
  }
  if (!isJsonString(input.currency) || input.currency.length === 0) {
    throw new StubSchemaError({
      operation: "charge",
      path: "currency",
      expected: "non-empty string",
      actual: input.currency,
    });
  }
}

function validateChargeOutput(output) {
  assertObject(output, "charge.output");
  if (output.status !== "ok" && output.status !== "declined") {
    throw new StubSchemaError({
      operation: "charge",
      path: "status",
      expected: '"ok" | "declined"',
      actual: output.status,
    });
  }
  if (!isJsonString(output.transactionId) || output.transactionId.length === 0) {
    throw new StubSchemaError({
      operation: "charge",
      path: "transactionId",
      expected: "non-empty string",
      actual: output.transactionId,
    });
  }
}

function assertObject(value, label) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new StubSchemaError({
      operation: label,
      path: "$",
      expected: "object",
      actual: value,
    });
  }
}

function linkKey(componentId, importInterface) {
  return `${componentId}\0${importInterface}`;
}

function assertId(id, kind) {
  if (!isJsonString(id) || id.length === 0) {
    throw new Error(`stub.${kind}_id_required`);
  }
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
