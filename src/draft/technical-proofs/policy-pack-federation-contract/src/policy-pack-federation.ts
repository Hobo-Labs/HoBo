import { isJsonString, isJsonObject } from "./json.js";
import { createHash, sign, verify } from "node:crypto";
import {

  POLICY_PACK_SCHEMA,
  SCOPE_ORDER,
  canonicalJson
} from "../../deny-ceiling-algebra-poc/src/deny-ceiling-algebra.js";

export const SIGNED_POLICY_PACK_SCHEMA = "hobo.signed-policy-pack/v1";
export const POLICY_PACK_SIGNATURE_ALGORITHM = "ed25519";
export const POLICY_PROPAGATED_EVENT_TYPE = "junction.PolicyPropagated";

const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const TARGET_KINDS = new Set(["junction", "yard", "camp", "bindle"]);
const SCOPE_SET = new Set(SCOPE_ORDER);
const ENVELOPE_FIELDS = new Set(["schemaVersion", "pack", "signature"]);
const SIGNATURE_FIELDS = new Set(["alg", "keyId", "value"]);
const PACK_FIELDS = new Set(["schema", "id", "version", "scope", "targets", "rules"]);
const TARGET_FIELDS = new Set(["kind", "id", "environment"]);
const RULE_FIELDS = new Set(["id", "mode", "denies", "allows", "limits"]);
const LIMIT_FIELDS = new Set(["key", "maximum"]);

export function createPolicyPack(packInput) {
  if (!isPlainObject(packInput)) {
    throw new TypeError("policy pack must be an object");
  }
  assertAllowedKeys(packInput, PACK_FIELDS, "pack");
  if (packInput.schema !== undefined && packInput.schema !== POLICY_PACK_SCHEMA) {
    throw new TypeError(`pack.schema must be ${POLICY_PACK_SCHEMA}`);
  }
  const { id, version, scope, targets, rules = [] } = packInput;
  const pack = {
    schema: POLICY_PACK_SCHEMA,
    id: requiredString(id, "id"),
    version: requiredSemver(version, "version"),
    scope: requiredScope(scope),
    targets: parseTargets(targets),
    rules: parseRules(rules)
  };
  return sortPack(pack);
}

export function signPolicyPack(packInput, { keyId, privateKey }) {
  const pack = createPolicyPack(packInput);
  const payload = canonicalJson(pack);
  return {
    schemaVersion: SIGNED_POLICY_PACK_SCHEMA,
    pack,
    signature: {
      alg: POLICY_PACK_SIGNATURE_ALGORITHM,
      keyId: requiredString(keyId, "keyId"),
      value: sign(null, Buffer.from(payload), privateKey).toString("base64url")
    }
  };
}

export function verifySignedPolicyPack(envelopeInput, trustStore) {
  try {
    const envelope = parseEnvelope(envelopeInput);
    const trustedKey = trustStore?.[envelope.signature.keyId];
    if (!trustedKey) {
      return fail(`no trusted key for ${envelope.signature.keyId}`);
    }

    const signatureOk = verify(
      null,
      Buffer.from(canonicalJson(envelope.pack)),
      trustedKey,
      Buffer.from(envelope.signature.value, "base64url")
    );
    if (!signatureOk) {
      return fail("signature verification failed");
    }

    return {
      ok: true,
      envelope,
      policyPack: toCompositionPack(envelope.pack),
      packVersion: `${envelope.pack.id}@${envelope.pack.version}`,
      targets: envelope.pack.targets,
      signer: envelope.signature.keyId
    };
  } catch (error) {
    return fail(error.message);
  }
}

export function loadSignedPolicyPacks(envelopes, trustStore) {
  if (!Array.isArray(envelopes)) {
    return { ok: false, errors: ["envelopes must be an array"], policyPacks: [] };
  }

  const verified = envelopes.map((envelope) => verifySignedPolicyPack(envelope, trustStore));
  const errors = verified.flatMap((result, index) => result.ok ? [] : [`pack[${index}]: ${result.error}`]);
  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      policyPacks: []
    };
  }

  return {
    ok: true,
    errors: [],
    policyPacks: verified.map((result) => result.policyPack),
    packVersions: verified.map((result) => result.packVersion).sort(),
    targets: verified.flatMap((result) => result.targets)
  };
}

export function federatePolicyPackToYards({ envelope, junctionId, yardIds }) {
  const parsed = parseEnvelope(envelope);
  const targetYards = parseYardIds(yardIds);
  const envelopeDigest = digestEnvelope(parsed);
  const event = {
    type: POLICY_PROPAGATED_EVENT_TYPE,
    junctionId: requiredString(junctionId, "junctionId"),
    pack: {
      id: parsed.pack.id,
      version: parsed.pack.version,
      keyId: parsed.signature.keyId,
      envelopeDigest
    },
    targetYards
  };

  return {
    event,
    deliveries: targetYards.map((yardId) => ({
      yardId,
      envelope: structuredClone(parsed),
      envelopeDigest
    }))
  };
}

function parseEnvelope(envelopeInput) {
  if (!isPlainObject(envelopeInput)) {
    throw new TypeError("signed policy pack envelope must be an object");
  }
  assertAllowedKeys(envelopeInput, ENVELOPE_FIELDS, "envelope");
  if (envelopeInput.schemaVersion !== SIGNED_POLICY_PACK_SCHEMA) {
    throw new TypeError(`schemaVersion must be ${SIGNED_POLICY_PACK_SCHEMA}`);
  }
  if (!isPlainObject(envelopeInput.signature)) {
    throw new TypeError("signature must be present");
  }
  assertAllowedKeys(envelopeInput.signature, SIGNATURE_FIELDS, "signature");
  if (envelopeInput.signature.alg !== POLICY_PACK_SIGNATURE_ALGORITHM) {
    throw new TypeError(`signature.alg must be ${POLICY_PACK_SIGNATURE_ALGORITHM}`);
  }
  const pack = createPolicyPack(envelopeInput.pack);
  return {
    schemaVersion: SIGNED_POLICY_PACK_SCHEMA,
    pack,
    signature: {
      alg: POLICY_PACK_SIGNATURE_ALGORITHM,
      keyId: requiredString(envelopeInput.signature.keyId, "signature.keyId"),
      value: requiredString(envelopeInput.signature.value, "signature.value")
    }
  };
}

function toCompositionPack(pack) {
  return {
    schema: POLICY_PACK_SCHEMA,
    id: `${pack.id}@${pack.version}`,
    scope: pack.scope,
    rules: pack.rules
  };
}

function sortPack(pack) {
  return {
    ...pack,
    targets: [...pack.targets].sort(compareTargets),
    rules: [...pack.rules].sort((left, right) => left.id.localeCompare(right.id))
  };
}

function parseTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new TypeError("targets must be a non-empty array");
  }
  return targets.map((target, index) => {
    if (!isPlainObject(target)) {
      throw new TypeError(`targets[${index}] must be an object`);
    }
    assertAllowedKeys(target, TARGET_FIELDS, `targets[${index}]`);
    const kind = requiredString(target.kind, `targets[${index}].kind`);
    if (!TARGET_KINDS.has(kind)) {
      throw new TypeError(`targets[${index}].kind must be one of ${[...TARGET_KINDS].join(", ")}`);
    }
    return {
      kind,
      id: requiredString(target.id, `targets[${index}].id`),
      environment: requiredString(target.environment, `targets[${index}].environment`)
    };
  });
}

function parseRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new TypeError("rules must be a non-empty array");
  }
  const ids = new Set();
  return rules.map((rule, index) => {
    if (!isPlainObject(rule)) {
      throw new TypeError(`rules[${index}] must be an object`);
    }
    assertAllowedKeys(rule, RULE_FIELDS, `rules[${index}]`);
    const id = requiredString(rule.id, `rules[${index}].id`);
    if (ids.has(id)) {
      throw new TypeError(`duplicate rule id ${id}`);
    }
    ids.add(id);
    const mode = rule.mode ?? "mandatory";
    if (!["mandatory", "default"].includes(mode)) {
      throw new TypeError(`${id}.mode must be mandatory or default`);
    }
    if (mode === "mandatory" && (rule.allows ?? []).length > 0) {
      throw new TypeError(`${id}: mandatory rules cannot allow`);
    }
    return {
      id,
      mode,
      denies: parseStringList(rule.denies ?? [], `${id}.denies`),
      allows: parseStringList(rule.allows ?? [], `${id}.allows`),
      limits: parseLimits(rule.limits ?? [], `${id}.limits`)
    };
  });
}

function parseLimits(limits, path) {
  if (!Array.isArray(limits)) {
    throw new TypeError(`${path} must be an array`);
  }
  return limits.map((limit, index) => {
    if (!isPlainObject(limit)) {
      throw new TypeError(`${path}[${index}] must be an object`);
    }
    assertAllowedKeys(limit, LIMIT_FIELDS, `${path}[${index}]`);
    if (!Number.isFinite(limit.maximum)) {
      throw new TypeError(`${path}[${index}].maximum must be finite`);
    }
    return {
      key: requiredString(limit.key, `${path}[${index}].key`),
      maximum: limit.maximum
    };
  });
}

function parseStringList(values, path) {
  if (!Array.isArray(values)) {
    throw new TypeError(`${path} must be an array`);
  }
  return values.map((value, index) => requiredString(value, `${path}[${index}]`));
}

function parseYardIds(yardIds) {
  if (!Array.isArray(yardIds) || yardIds.length === 0) {
    throw new TypeError("yardIds must be a non-empty array");
  }
  return [...new Set(yardIds.map((yardId, index) => requiredString(yardId, `yardIds[${index}]`)))].sort();
}

function digestEnvelope(envelope) {
  return `sha256:${createHash("sha256").update(canonicalJson(envelope)).digest("hex")}`;
}

function compareTargets(left, right) {
  return `${left.kind}:${left.id}:${left.environment}`.localeCompare(`${right.kind}:${right.id}:${right.environment}`);
}

function requiredScope(scope) {
  const parsed = requiredString(scope, "scope");
  if (!SCOPE_SET.has(parsed)) {
    throw new TypeError(`scope must be one of ${SCOPE_ORDER.join(", ")}`);
  }
  return parsed;
}

function requiredSemver(value, path) {
  const parsed = requiredString(value, path);
  if (!SEMVER_RE.test(parsed)) {
    throw new TypeError(`${path} must be semver`);
  }
  return parsed;
}

function requiredString(value, path) {
  if (!isJsonString(value) || value.trim() === "") {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

function assertAllowedKeys(value, allowedFields, path) {
  const unexpected = Object.keys(value).filter((key) => !allowedFields.has(key));
  if (unexpected.length > 0) {
    throw new TypeError(`${path} has unexpected field ${unexpected[0]}`);
  }
}

function fail(error) {
  return {
    ok: false,
    error
  };
}

function isPlainObject(value) {
  return (
    value !== null &&
    isJsonObject(value) &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
