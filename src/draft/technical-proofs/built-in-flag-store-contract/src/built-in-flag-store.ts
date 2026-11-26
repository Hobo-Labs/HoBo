import {
  replayFlagEvents,
  validateFlagEvent
} from "../../flag-event-contract/src/flag-event-contract.js";
import { isJsonString, isJsonNumber, isJsonBoolean, isJsonObject } from "./json.js";

export function createBuiltInFlagStore(entries = []) {
  const log = entries.map(validateEntry).sort((left, right) => left.seq - right.seq);

  function snapshotAt(seq = log.at(-1)?.seq ?? 0) {
    const events = log.filter((entry) => entry.seq <= seq).map((entry) => entry.event);

    return {
      seq,
      flags: replayFlagEvents(events).flags
    };
  }

  return {
    snapshotAt,
    providerAt: (seq) => createBuiltInFlagProvider(snapshotAt(seq))
  };
}

export function createBuiltInFlagProvider(ruleset) {
  return {
    getBooleanValue: (flagKey, defaultValue, context) =>
      evaluate(ruleset, "boolean", flagKey, defaultValue, context).value,
    getBooleanDetails: (flagKey, defaultValue, context) =>
      evaluate(ruleset, "boolean", flagKey, defaultValue, context),
    getStringValue: (flagKey, defaultValue, context) =>
      evaluate(ruleset, "string", flagKey, defaultValue, context).value,
    getStringDetails: (flagKey, defaultValue, context) =>
      evaluate(ruleset, "string", flagKey, defaultValue, context),
    getNumberValue: (flagKey, defaultValue, context) =>
      evaluate(ruleset, "number", flagKey, defaultValue, context).value,
    getNumberDetails: (flagKey, defaultValue, context) =>
      evaluate(ruleset, "number", flagKey, defaultValue, context),
    getObjectValue: (flagKey, defaultValue, context) =>
      evaluate(ruleset, "object", flagKey, defaultValue, context).value,
    getObjectDetails: (flagKey, defaultValue, context) =>
      evaluate(ruleset, "object", flagKey, defaultValue, context)
  };
}

function evaluate(ruleset, valueType, flagKey, defaultValue, context = {}) {
  const bucket = stableBucket(flagKey, subjectKey(context));
  const flag = ruleset?.flags?.[flagKey];

  if (!flag) {
    return defaultDetails(flagKey, defaultValue, bucket, ruleset?.seq);
  }
  if (flag.valueType !== valueType || !isValue(valueType, flag.currentValue)) {
    return defaultDetails(flagKey, defaultValue, bucket, ruleset?.seq, {
      code: "malformed-ruleset",
      message: `${flagKey} has invalid ${valueType} value at ruleset seq ${ruleset?.seq}`
    });
  }

  if (!matchesTargeting(flag.targeting ?? [], context)) {
    return defaultDetails(flagKey, defaultValue, bucket, ruleset.seq);
  }

  return {
    flagKey,
    value: cloneJson(flag.currentValue),
    reason: flag.targeting?.length > 0 ? "targeting-match" : "static",
    variant: valueType === "boolean" && flag.currentValue === true ? "on" : "selected",
    bucket,
    rulesetSeq: ruleset.seq
  };
}

function defaultDetails(flagKey, defaultValue, bucket, rulesetSeq, error) {
  const details = {
    flagKey,
    value: cloneJson(defaultValue),
    reason: error ? "error" : "default",
    variant: "default",
    bucket,
    rulesetSeq
  };

  if (error) {
    details.error = error;
  }

  return details;
}

function validateEntry(entry) {
  if (!Number.isInteger(entry?.seq) || entry.seq < 0) {
    throw new Error("flag store entry requires a non-negative integer seq");
  }

  return {
    seq: entry.seq,
    event: validateFlagEvent(entry.event)
  };
}

function matchesTargeting(rules, context) {
  return rules.every((rule) => {
    const actual = resolveAttribute(rule.attribute, context);

    switch (rule.op) {
      case "equals":
        return sameValue(actual, rule.value);
      case "notEquals":
        return !sameValue(actual, rule.value);
      case "in":
        return Array.isArray(rule.value) && rule.value.some((value) => sameValue(actual, value));
      case "exists":
        return actual !== undefined;
      default:
        return false;
    }
  });
}

function resolveAttribute(attribute, context) {
  if (attribute.startsWith("user.")) {
    return resolvePrincipalAttribute(context.user, attribute.slice("user.".length));
  }
  if (attribute.startsWith("identity.")) {
    return resolvePrincipalAttribute(context.identity, attribute.slice("identity.".length));
  }

  const attributes = Array.isArray(context.attributes) ? context.attributes : [];
  const attr = attributes.find((candidate) => candidate.key === attribute);
  return normalizeValue(attr?.value);
}

function resolvePrincipalAttribute(principal, name) {
  if (!principal) {
    return undefined;
  }
  if (name === "id" || name === "tenant" || name === "kind") {
    return principal[name];
  }

  const claims = Array.isArray(principal.claims) ? principal.claims : [];
  const claim = claims.find((candidate) => candidate.key === name);
  return normalizeValue(claim?.value);
}

function subjectKey(context) {
  return context.user?.id ?? context.identity?.id ?? "anonymous";
}

function stableBucket(flagKey, subject) {
  const input = `${flagKey}\0${subject}`;
  let hash = 2166136261;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0) % 10000;
}

function normalizeValue(value) {
  if (value && isJsonObject(value) && "tag" in value && "val" in value) {
    return value.val;
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(normalizeValue(left)) === JSON.stringify(normalizeValue(right));
}

function isValue(valueType, value) {
  return (
    (valueType === "boolean" && isJsonBoolean(value)) ||
    (valueType === "string" && isJsonString(value)) ||
    (valueType === "number" && isJsonNumber(value) && Number.isFinite(value)) ||
    (valueType === "object" && value !== null && isJsonObject(value))
  );
}

function cloneJson(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}
