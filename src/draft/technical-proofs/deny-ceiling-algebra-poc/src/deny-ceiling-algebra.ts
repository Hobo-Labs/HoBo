import { isJsonString, isJsonObject } from "./json.js";
export const SCOPE_ORDER = ["junction", "yard", "camp", "bindle"];
export const POLICY_PACK_SCHEMA = "hobo.policy-pack/v1";
export const COMPOSITION_SCHEMA = "hobo.policy-deny-ceiling-composition/v1";

const SCOPE_RANK = new Map(SCOPE_ORDER.map((scope, index) => [scope, index]));

export function definePolicyPack({ id, scope, rules = [] }) {
  return {
    schema: POLICY_PACK_SCHEMA,
    id,
    scope,
    rules
  };
}

export function denyRule({ id, mode = "mandatory", tuple }) {
  return {
    id,
    mode,
    denies: [tuple],
    allows: [],
    limits: []
  };
}

export function allowRule({ id, mode = "default", tuple }) {
  return {
    id,
    mode,
    denies: [],
    allows: [tuple],
    limits: []
  };
}

export function limitRule({ id, mode = "mandatory", key, maximum }) {
  return {
    id,
    mode,
    denies: [],
    allows: [],
    limits: [{ key, maximum }]
  };
}

export function composePolicyPacks(packs) {
  const errors = validatePacks(packs);
  const sorted = Array.isArray(packs) ? [...packs].sort(comparePacks) : [];
  const mandatoryDenies = new Map();
  const defaultDecisions = new Map();
  const mandatoryLimits = new Map();
  const grantViolations = [];

  for (const pack of sorted) {
    for (const rule of sortedRules(pack)) {
      const source = sourceId(pack, rule);
      const mode = rule.mode ?? "mandatory";

      if (mode === "mandatory") {
        for (const tuple of rule.denies ?? []) {
          addSource(mandatoryDenies, tuple, source);
        }

        for (const limit of rule.limits ?? []) {
          const current = mandatoryLimits.get(limit.key);
          if (!current || limit.maximum < current.maximum || (limit.maximum === current.maximum && source < current.source)) {
            mandatoryLimits.set(limit.key, { maximum: limit.maximum, source });
          }
        }
      }
    }
  }

  for (const pack of sorted) {
    for (const rule of sortedRules(pack)) {
      const source = sourceId(pack, rule);
      const mode = rule.mode ?? "mandatory";

      if (mode === "default") {
        for (const tuple of rule.denies ?? []) {
          defaultDecisions.set(tuple, { effect: "deny", source });
        }
      }

      for (const tuple of rule.allows ?? []) {
        if (mandatoryDenies.has(tuple)) {
          grantViolations.push(
            `${source} attempts to allow ${tuple}, but mandatory deny exists at ${mandatoryDenies.get(tuple).join(", ")}`
          );
          continue;
        }
        defaultDecisions.set(tuple, { effect: "allow", source });
      }
    }
  }

  const defaultDenies = [];
  for (const [tuple, decision] of defaultDecisions) {
    if (decision.effect === "deny" && !mandatoryDenies.has(tuple)) {
      defaultDenies.push({ tuple, source: decision.source });
    }
  }

  const effectiveDenySet = [
    ...[...mandatoryDenies.keys()].map((tuple) => ({ tuple, mode: "mandatory", sources: mandatoryDenies.get(tuple) })),
    ...defaultDenies.map(({ tuple, source }) => ({ tuple, mode: "default", sources: [source] }))
  ].sort(compareDenyEntries);

  return {
    schema: COMPOSITION_SCHEMA,
    ok: errors.length === 0 && grantViolations.length === 0,
    errors,
    violations: grantViolations,
    effectiveDenySet,
    mandatoryLimits: [...mandatoryLimits.entries()]
      .map(([key, value]) => ({ key, maximum: value.maximum, source: value.source }))
      .sort((left, right) => left.key.localeCompare(right.key)),
    packOrder: sorted.map((pack) => pack.id)
  };
}

export function isScopeMonotonic(parentComposition, childComposition) {
  const parentMandatory = new Set(
    parentComposition.effectiveDenySet
      .filter((entry) => entry.mode === "mandatory")
      .map((entry) => entry.tuple)
  );
  const childMandatory = new Set(
    childComposition.effectiveDenySet
      .filter((entry) => entry.mode === "mandatory")
      .map((entry) => entry.tuple)
  );

  return [...parentMandatory].every((tuple) => childMandatory.has(tuple));
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function validatePacks(packs) {
  const errors = [];
  if (!Array.isArray(packs)) {
    return ["packs must be an array"];
  }
  for (const pack of packs) {
    if (!pack || !isJsonObject(pack) || Array.isArray(pack)) {
      errors.push("pack must be an object");
      continue;
    }
    if (pack.schema !== POLICY_PACK_SCHEMA) {
      errors.push(`${pack.id ?? "pack"} schema must be ${POLICY_PACK_SCHEMA}`);
    }
    if (!isNonEmptyString(pack.id)) {
      errors.push("pack.id must be a non-empty string");
    }
    if (!SCOPE_RANK.has(pack.scope)) {
      errors.push(`${pack.id ?? "pack"} scope must be one of ${SCOPE_ORDER.join(", ")}`);
    }
    if (!Array.isArray(pack.rules)) {
      errors.push(`${pack.id ?? "pack"} rules must be an array`);
      continue;
    }
    for (const rule of pack.rules) {
      validateRule(pack, rule, errors);
    }
  }
  return errors;
}

function validateRule(pack, rule, errors) {
  if (!rule || !isJsonObject(rule) || Array.isArray(rule)) {
    errors.push(`${pack.id}: rule must be an object`);
    return;
  }
  if (!isNonEmptyString(rule.id)) {
    errors.push(`${pack.id}: rule.id must be a non-empty string`);
  }
  if (!["mandatory", "default"].includes(rule.mode ?? "mandatory")) {
    errors.push(`${sourceId(pack, rule)} mode must be mandatory or default`);
  }
  if ((rule.mode ?? "mandatory") === "mandatory" && (rule.allows ?? []).length > 0) {
    errors.push(`${sourceId(pack, rule)} mandatory rules must be denies or bounded maxima`);
  }
  for (const tuple of [...(rule.denies ?? []), ...(rule.allows ?? [])]) {
    if (!isNonEmptyString(tuple)) {
      errors.push(`${sourceId(pack, rule)} tuples must be non-empty strings`);
    }
  }
  for (const limit of rule.limits ?? []) {
    if (!isNonEmptyString(limit.key)) {
      errors.push(`${sourceId(pack, rule)} limit.key must be a non-empty string`);
    }
    if (!Number.isFinite(limit.maximum)) {
      errors.push(`${sourceId(pack, rule)} limit.maximum must be finite`);
    }
  }
}

function comparePacks(left, right) {
  const scopeCompare = SCOPE_RANK.get(left.scope) - SCOPE_RANK.get(right.scope);
  if (scopeCompare !== 0) {
    return scopeCompare;
  }
  return left.id.localeCompare(right.id);
}

function sortedRules(pack) {
  return [...pack.rules].sort((left, right) => left.id.localeCompare(right.id));
}

function addSource(map, tuple, source) {
  const existing = map.get(tuple) ?? [];
  map.set(tuple, [...existing, source].sort());
}

function sourceId(pack, rule) {
  return `${pack.scope}:${pack.id}/${rule.id ?? "rule"}`;
}

function compareDenyEntries(left, right) {
  const tupleCompare = left.tuple.localeCompare(right.tuple);
  if (tupleCompare !== 0) {
    return tupleCompare;
  }
  return left.mode.localeCompare(right.mode);
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}
