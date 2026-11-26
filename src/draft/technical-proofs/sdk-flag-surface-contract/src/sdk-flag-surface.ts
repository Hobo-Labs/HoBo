import {
  createFlagContract,
  validateFlagEvent,
} from "../../flag-event-contract/src/flag-event-contract.js";
import { createBuiltInFlagStore } from "../../built-in-flag-store-contract/src/built-in-flag-store.js";
import { isJsonString, isJsonObject } from "./json.js";


const emptyContext = Object.freeze({ attributes: [] });

export function createSdkFlagContract(options = {}) {
  const contract = createFlagContract(options);

  return {
    flag: {
      boolean: (key, config) => decorate(contract.flag.boolean(key, config), "boolean", config),
      string: (key, config) => decorate(contract.flag.string(key, config), "string", config),
      number: (key, config) => decorate(contract.flag.number(key, config), "number", config),
      object: (key, config) => decorate(contract.flag.object(key, config), "object", config),
    },
  };
}

export function createFlagSurfaceEventLog(entries = []) {
  let log = normalizeEntries(entries);
  const listeners = new Set();

  function notify() {
    for (const listener of listeners) {
      listener(entriesSnapshot());
    }
  }

  function entriesSnapshot() {
    return clone(log);
  }

  return {
    append(entry) {
      this.appendBatch([entry]);
    },
    appendBatch(nextEntries) {
      log = normalizeEntries([...log, ...nextEntries]);
      notify();
    },
    entries: entriesSnapshot,
    subscribe(listener) {
      if (!(listener instanceof Function)) {
        throw new Error("flag surface event-log subscriber must be a function");
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function createSdkFlagSurface(options = {}) {
  const eventLog = options.eventLog ?? createFlagSurfaceEventLog();
  const requestContext = options.requestContext instanceof Function ? options.requestContext : () => emptyContext;
  const clientContext = normalizeContext(options.clientContext);

  async function details(flag, context) {
    return evaluateFlag(flag, normalizeContext(context ?? requestContext()), eventLog);
  }

  return {
    ctx: {
      flags: {
        async eval(flag, context) {
          return (await details(flag, context)).value;
        },
        details,
        async bucket(flag, context) {
          return (await details(flag, context)).bucket;
        },
      },
    },
    useFlag(flag, hookOptions = {}) {
      const context = normalizeContext(hookOptions.clientContext ?? clientContext);
      let current = evaluateFlag(flag, context, eventLog);
      let renderCount = 1;

      const unsubscribe = eventLog.subscribe(() => {
        const next = evaluateFlag(flag, context, eventLog);
        if (stableStringify(next) === stableStringify(current)) {
          return;
        }
        current = next;
        renderCount += 1;
      });

      return {
        value: () => clone(current.value),
        details: () => clone(current),
        renderCount: () => renderCount,
        unsubscribe,
      };
    },
  };
}

function decorate(declared, valueType, config) {
  return {
    key: declared.ref.key,
    type: valueType,
    defaultValue: clone(config.default),
    ref: declared.ref,
    event: declared.event,
  };
}

function evaluateFlag(flag, context, eventLog) {
  validateSdkFlag(flag);
  const entries = eventLog.entries();
  const store = createBuiltInFlagStore(entries);
  const snapshot = store.snapshotAt();
  const state = snapshot.flags[flag.key];

  if (state?.archived) {
    return {
      flagKey: flag.key,
      value: clone(flag.defaultValue),
      reason: "archived",
      variant: "default",
      rulesetSeq: snapshot.seq,
      deprecation: {
        code: "flag-archived",
        message: `flag ${flag.key} is archived; default returned`,
      },
    };
  }

  return store.providerAt(snapshot.seq)[detailsMethod(flag.type)](
    flag.key,
    clone(flag.defaultValue),
    context,
  );
}

function detailsMethod(valueType) {
  switch (valueType) {
    case "boolean":
      return "getBooleanDetails";
    case "string":
      return "getStringDetails";
    case "number":
      return "getNumberDetails";
    case "object":
      return "getObjectDetails";
    default:
      throw new Error(`unsupported flag value type ${valueType}`);
  }
}

function validateSdkFlag(flag) {
  if (!flag || !isJsonObject(flag)) {
    throw new Error("flag reference must be an object");
  }
  if (!isJsonString(flag.key) || flag.key.length === 0) {
    throw new Error("flag reference requires key");
  }
  if (!["boolean", "string", "number", "object"].includes(flag.type)) {
    throw new Error(`unsupported flag value type ${flag.type}`);
  }
}

function normalizeEntries(entries) {
  if (!Array.isArray(entries)) {
    throw new Error("flag surface event log entries must be an array");
  }

  return entries
    .map((entry) => {
      if (!Number.isInteger(entry?.seq) || entry.seq < 0) {
        throw new Error("flag surface event entry requires a non-negative integer seq");
      }
      return {
        seq: entry.seq,
        event: validateFlagEvent(entry.event),
      };
    })
    .sort((left, right) => left.seq - right.seq);
}

function normalizeContext(context) {
  if (!context || !isJsonObject(context)) {
    return clone(emptyContext);
  }

  return {
    ...clone(context),
    attributes: Array.isArray(context.attributes) ? clone(context.attributes) : [],
  };
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone instanceof Function ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}
