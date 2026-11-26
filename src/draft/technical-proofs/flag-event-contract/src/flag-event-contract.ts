import { isJsonString, isJsonNumber, isJsonBoolean, isJsonObject } from "./json.js";
const valueTypes = new Set(["boolean", "string", "number", "object"]);
const targetingOps = new Set(["equals", "notEquals", "in", "exists"]);

export function createFlagContract(options = {}) {
  const knownTargetingAttributes = new Set(options.knownTargetingAttributes ?? []);
  const definitions = new Map();

  function define(valueType, key, config) {
    validateKey(key);
    assertValue(valueType, config?.default, "default");
    const targeting = normalizeTargeting(config?.targeting ?? [], knownTargetingAttributes);

    const existing = definitions.get(key);
    if (existing && existing.valueType !== valueType) {
      throw new Error(`cannot redefine flag ${key} from ${existing.valueType} to ${valueType}`);
    }

    const data = {
      key,
      valueType,
      defaultValue: cloneJson(config.default),
      targeting
    };
    const event = createEvent("flag.Defined", data);
    definitions.set(key, data);

    return {
      ref: { key, type: valueType },
      event
    };
  }

  return {
    flag: {
      boolean: (key, config) => define("boolean", key, config),
      string: (key, config) => define("string", key, config),
      number: (key, config) => define("number", key, config),
      object: (key, config) => define("object", key, config)
    }
  };
}

export function createFlagChanged(ref, input) {
  validateRef(ref);
  if (!input?.actor) {
    throw new Error("flag.Changed requires actor attribution");
  }
  validatePrincipal(input.actor);

  const hasValue = Object.hasOwn(input, "to");
  const diff = {};
  if (hasValue) {
    assertValue(ref.type, input.from, "from");
    assertValue(ref.type, input.to, "to");
    diff.value = {
      from: cloneJson(input.from),
      to: cloneJson(input.to)
    };
  }

  if (input.targeting) {
    diff.targeting = {
      from: normalizeTargeting(input.targeting.from ?? [], new Set()),
      to: normalizeTargeting(input.targeting.to ?? [], new Set())
    };
  }

  if (Object.keys(diff).length === 0) {
    throw new Error("flag.Changed requires a value or targeting diff");
  }

  return createEvent(
    "flag.Changed",
    {
      key: ref.key,
      valueType: ref.type,
      diff,
      reason: input.reason ?? "changed"
    },
    input.actor
  );
}

export function createFlagEvaluated(ref, input) {
  validateRef(ref);
  if (!input?.sampled) {
    return null;
  }
  if (input.actor) {
    validatePrincipal(input.actor);
  }
  assertValue(ref.type, input.value, "value");

  return createEvent(
    "flag.Evaluated",
    {
      key: ref.key,
      valueType: ref.type,
      value: cloneJson(input.value),
      reason: input.reason ?? "unknown",
      variant: input.variant,
      sampled: true
    },
    input.actor
  );
}

export function createFlagArchived(ref, input) {
  validateRef(ref);
  if (!input?.actor) {
    throw new Error("flag.Archived requires actor attribution");
  }
  validatePrincipal(input.actor);

  return createEvent(
    "flag.Archived",
    {
      key: ref.key,
      valueType: ref.type,
      reason: input.reason ?? "archived"
    },
    input.actor
  );
}

export function validateFlagEvent(event) {
  if (!event || !isJsonObject(event)) {
    throw new TypeError("flag event must be an object");
  }
  if (event.version !== 1) {
    throw new Error("flag event version must be 1");
  }
  if (!isJsonString(event.streamId) || !event.streamId.startsWith("flag:")) {
    throw new Error("flag event streamId must start with flag:");
  }

  switch (event.type) {
    case "flag.Defined":
      validateDefined(event);
      break;
    case "flag.Changed":
      validateChanged(event);
      break;
    case "flag.Evaluated":
      validateEvaluated(event);
      break;
    case "flag.Archived":
      validateArchived(event);
      break;
    default:
      throw new Error(`unknown flag event type ${event.type}`);
  }

  return event;
}

export function replayFlagEvents(events) {
  const flags = {};

  for (const event of events) {
    validateFlagEvent(event);
    const key = event.data.key;

    switch (event.type) {
      case "flag.Defined": {
        const existing = flags[key];
        if (existing && existing.valueType !== event.data.valueType) {
          throw new Error(
            `cannot replay redefinition of ${key} from ${existing.valueType} to ${event.data.valueType}`
          );
        }
        flags[key] = {
          key,
          valueType: event.data.valueType,
          defaultValue: cloneJson(event.data.defaultValue),
          currentValue: cloneJson(existing?.currentValue ?? event.data.defaultValue),
          targeting: cloneJson(event.data.targeting),
          archived: existing?.archived ?? false
        };
        break;
      }
      case "flag.Changed": {
        const current = requireDefined(flags, key);
        if (current.valueType !== event.data.valueType) {
          throw new Error(`flag.Changed value type mismatch for ${key}`);
        }
        if (event.data.diff.value) {
          current.currentValue = cloneJson(event.data.diff.value.to);
        }
        if (event.data.diff.targeting) {
          current.targeting = cloneJson(event.data.diff.targeting.to);
        }
        break;
      }
      case "flag.Evaluated":
        requireDefined(flags, key);
        break;
      case "flag.Archived":
        requireDefined(flags, key).archived = true;
        break;
    }
  }

  return { flags };
}

function createEvent(type, data, actor) {
  const event = {
    type,
    version: 1,
    streamId: `flag:${data.key}`,
    data: cloneJson(data)
  };

  if (actor) {
    event.actor = cloneJson(actor);
  }

  return validateFlagEvent(event);
}

function assertStreamMatchesKey(event) {
  if (event.streamId !== `flag:${event.data.key}`) {
    throw new Error("flag event streamId must match data key");
  }
}

function validateDefined(event) {
  const data = event.data;
  validateKey(data?.key);
  assertStreamMatchesKey(event);
  validateValueType(data.valueType);
  assertValue(data.valueType, data.defaultValue, "defaultValue");
  normalizeTargeting(data.targeting ?? [], new Set());
}

function validateChanged(event) {
  validatePrincipal(event.actor);
  const data = event.data;
  validateKey(data?.key);
  assertStreamMatchesKey(event);
  validateValueType(data.valueType);
  if (!data.diff || !isJsonObject(data.diff)) {
    throw new Error("flag.Changed requires a diff");
  }
  if (data.diff.value) {
    assertValue(data.valueType, data.diff.value.from, "diff.value.from");
    assertValue(data.valueType, data.diff.value.to, "diff.value.to");
  }
  if (data.diff.targeting) {
    normalizeTargeting(data.diff.targeting.from ?? [], new Set());
    normalizeTargeting(data.diff.targeting.to ?? [], new Set());
  }
  if (!data.diff.value && !data.diff.targeting) {
    throw new Error("flag.Changed requires a value or targeting diff");
  }
}

function validateEvaluated(event) {
  const data = event.data;
  validateKey(data?.key);
  assertStreamMatchesKey(event);
  validateValueType(data.valueType);
  assertValue(data.valueType, data.value, "value");
  if (data.sampled !== true) {
    throw new Error("flag.Evaluated must be sampled");
  }
}

function validateArchived(event) {
  validatePrincipal(event.actor);
  const data = event.data;
  validateKey(data?.key);
  assertStreamMatchesKey(event);
  validateValueType(data.valueType);
}

function validateRef(ref) {
  validateKey(ref?.key);
  validateValueType(ref.type);
}

function validateKey(key) {
  if (!isJsonString(key) || !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/.test(key)) {
    throw new Error(`invalid flag key ${key}`);
  }
}

function validateValueType(valueType) {
  if (!valueTypes.has(valueType)) {
    throw new Error(`unknown flag value type ${valueType}`);
  }
}

function assertValue(valueType, value, label) {
  const valid =
    (valueType === "boolean" && isJsonBoolean(value)) ||
    (valueType === "string" && isJsonString(value)) ||
    (valueType === "number" && isJsonNumber(value) && Number.isFinite(value)) ||
    (valueType === "object" && value !== null && isJsonObject(value) && isJsonSerializable(value));

  if (!valid) {
    throw new Error(`${label} must be a ${valueType} flag value`);
  }
}

function normalizeTargeting(targeting, knownTargetingAttributes) {
  if (!Array.isArray(targeting)) {
    throw new Error("targeting must be an array");
  }

  return targeting.map((rule) => {
    if (!rule || !isJsonObject(rule)) {
      throw new Error("targeting rule must be an object");
    }
    if (!isJsonString(rule.attribute) || rule.attribute.length === 0) {
      throw new Error("targeting rule requires an attribute");
    }
    if (
      knownTargetingAttributes.size > 0 &&
      !knownTargetingAttributes.has(rule.attribute)
    ) {
      throw new Error(`unknown targeting attribute ${rule.attribute}`);
    }
    if (!targetingOps.has(rule.op)) {
      throw new Error(`unknown targeting operator ${rule.op}`);
    }
    if (rule.op === "exists") {
      return { attribute: rule.attribute, op: rule.op };
    }
    if (!Object.hasOwn(rule, "value") || !isJsonSerializable(rule.value)) {
      throw new Error(`targeting rule ${rule.attribute} requires a JSON value`);
    }
    if (rule.op === "in" && !Array.isArray(rule.value)) {
      throw new Error(`targeting rule ${rule.attribute} with in requires an array`);
    }

    return {
      attribute: rule.attribute,
      op: rule.op,
      value: cloneJson(rule.value)
    };
  });
}

function validatePrincipal(actor) {
  if (!actor || !isJsonObject(actor)) {
    throw new Error("actor must be a PrincipalRef object");
  }
  for (const field of ["kind", "id", "tenant"]) {
    if (!isJsonString(actor[field]) || actor[field].length === 0) {
      throw new Error(`actor.${field} is required`);
    }
  }
}

function requireDefined(flags, key) {
  const current = flags[key];
  if (!current) {
    throw new Error(`flag ${key} must be defined before it can be used`);
  }
  return current;
}

function cloneJson(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function isJsonSerializable(value) {
  if (value === null) {
    return true;
  }
  if (isJsonBoolean(value) || isJsonString(value)) {
    return true;
  }
  if (isJsonNumber(value)) {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonSerializable);
  }
  if (isJsonObject(value)) {
    return Object.values(value).every(isJsonSerializable);
  }
  return false;
}
