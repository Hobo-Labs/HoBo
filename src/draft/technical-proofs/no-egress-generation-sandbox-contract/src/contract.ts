/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: these checks parse erased capability and path values at the sandbox boundary. */
import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


const profileSchema = "hobo.sandbox.profile/v1";
const conformanceSchema = "hobo.sandbox.conformance/v1";
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const requiredAssertions = [
  "no-egress",
  "capability-scoped",
  "scratch-only-write",
  "resource-budgeted"
];
const stabilityTiers = new Set(["stable", "preview", "experimental", "deprecated"]);
const escapeKinds = new Set(["network", "filesystem", "capability"]);
const egressCapabilityPrefixes = [
  "wasi:http/",
  "wasi:sockets/",
  "wasi:network/",
  "wasi:websocket/",
  "hobo:http/",
  "hobo:dns/",
  "hobo:relay/",
  "hobo:websocket/"
];

export class SandboxContractError extends Error {
  constructor(code, path = "$") {
    super(`${code} at ${path}`);
    this.code = code;
    this.path = path;
  }
}

export function validateSandboxProfile(profile) {
  assertObject(profile, "profile.invalid", "$");
  assertEqual(profile.schema, profileSchema, "profile.schema", "$.schema");
  assertNonEmptyString(profile.id, "profile.id", "$.id");
  validateIsolation(profile.isolation);
  validateNetwork(profile.network);
  validateFilesystem(profile.filesystem);
  validateCapabilities(profile.capabilities);
  validateResources(profile.resources);
  validateAssertions(profile.assertions);

  return profile;
}

export function profileDigest(profile) {
  const payload = stableStringify(validateSandboxProfile(profile));
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

export function declareConformanceRun(profile, input) {
  const validated = validateSandboxProfile(profile);
  assertObject(input, "conformance.invalid", "$");
  assertNonEmptyString(input.runId, "conformance.run_id", "$.runId");
  assertNonEmptyString(input.suiteId, "conformance.suite_id", "$.suiteId");
  assertNonEmptyString(input.artifactKind, "conformance.artifact_kind", "$.artifactKind");
  assertNonEmptyString(input.targetPort, "conformance.target_port", "$.targetPort");
  assertNonEmptyString(input.validator, "conformance.validator", "$.validator");

  return {
    schema: conformanceSchema,
    runId: input.runId,
    profileId: validated.id,
    profileDigest: profileDigest(validated),
    suiteId: input.suiteId,
    artifactKind: input.artifactKind,
    targetPort: input.targetPort,
    validator: input.validator,
    assertions: [...validated.assertions]
  };
}

export function validateSandboxEvent(event) {
  assertObject(event, "sandbox.event_invalid", "$");
  assertNonEmptyString(event.type, "sandbox.type_required", "$.type");
  assertNonEmptyString(event.runId, "sandbox.run_id_required", "$.runId");
  if (!digestPattern.test(event.profileDigest ?? "")) {
    throw new SandboxContractError("sandbox.profile_digest_required", "$.profileDigest");
  }

  if (event.type === "sandbox.EscapeAttemptBlocked") {
    validateEscapeAttempt(event.attempt);
  }

  return event;
}

function validateIsolation(isolation) {
  assertObject(isolation, "isolation.required", "$.isolation");
  if (isolation.tier !== "microvm" || isolation.engine !== "firecracker") {
    throw new SandboxContractError("isolation.microvm_required", "$.isolation");
  }
}

function validateNetwork(network) {
  assertObject(network, "network.required", "$.network");
  if (network.mode !== "none") {
    throw new SandboxContractError("network.egress_not_allowed", "$.network.mode");
  }
  if (!Array.isArray(network.allow) || network.allow.length !== 0) {
    throw new SandboxContractError("network.egress_not_allowed", "$.network.allow");
  }
}

function validateFilesystem(filesystem) {
  assertObject(filesystem, "filesystem.required", "$.filesystem");
  assertAbsolutePath(filesystem.scratch, "filesystem.scratch", "$.filesystem.scratch");
  if (filesystem.scratch === "/") {
    throw new SandboxContractError(
      "filesystem.scratch_root_forbidden",
      "$.filesystem.scratch"
    );
  }
  if (!Array.isArray(filesystem.writable) || filesystem.writable.length === 0) {
    throw new SandboxContractError("filesystem.writable_required", "$.filesystem.writable");
  }

  for (const [index, writable] of filesystem.writable.entries()) {
    assertAbsolutePath(writable, "filesystem.writable_path", `$.filesystem.writable[${index}]`);
    if (!isInside(filesystem.scratch, writable)) {
      throw new SandboxContractError(
        "filesystem.write_outside_scratch",
        `$.filesystem.writable[${index}]`
      );
    }
  }
}

function validateCapabilities(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    throw new SandboxContractError("capability.required", "$.capabilities");
  }

  for (const [index, capability] of capabilities.entries()) {
    const path = `$.capabilities[${index}]`;
    assertObject(capability, "capability.invalid", path);
    assertNonEmptyString(capability.interface, "capability.interface", `${path}.interface`);
    if (isEgressCapability(capability.interface)) {
      throw new SandboxContractError("capability.egress_not_allowed", `${path}.interface`);
    }
    if (!stabilityTiers.has(capability.stability)) {
      throw new SandboxContractError("capability.stability", `${path}.stability`);
    }
    if (!Array.isArray(capability.verbs) || capability.verbs.length === 0) {
      throw new SandboxContractError("capability.verbs_required", `${path}.verbs`);
    }
    if (!capability.verbs.every((verb) => isJsonString(verb) && verb.length > 0)) {
      throw new SandboxContractError("capability.verbs_required", `${path}.verbs`);
    }
    if (!isNonEmptyObject(capability.scope)) {
      throw new SandboxContractError("capability.scope_required", `${path}.scope`);
    }
  }
}

function validateResources(resources) {
  assertObject(resources, "resources.required", "$.resources");
  for (const field of ["cpuMs", "memoryMiB", "wallClockMs"]) {
    if (!Number.isInteger(resources[field]) || resources[field] <= 0) {
      throw new SandboxContractError("resources.positive_integer_required", `$.resources.${field}`);
    }
  }
}

function validateAssertions(assertions) {
  if (!Array.isArray(assertions)) {
    throw new SandboxContractError("assertions.required", "$.assertions");
  }
  for (const assertion of requiredAssertions) {
    if (!assertions.includes(assertion)) {
      throw new SandboxContractError("assertions.required", "$.assertions");
    }
  }
}

function validateEscapeAttempt(attempt) {
  assertObject(attempt, "sandbox.attempt_required", "$.attempt");
  if (!escapeKinds.has(attempt.kind)) {
    throw new SandboxContractError("sandbox.attempt_kind", "$.attempt.kind");
  }
  assertNonEmptyString(attempt.target, "sandbox.attempt_target", "$.attempt.target");
  if (attempt.decision !== "denied") {
    throw new SandboxContractError("sandbox.escape_attempt_must_be_denied", "$.attempt.decision");
  }
}

function assertEqual(actual, expected, code, path) {
  if (actual !== expected) {
    throw new SandboxContractError(code, path);
  }
}

function assertObject(value, code, path) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new SandboxContractError(code, path);
  }
}

function assertNonEmptyString(value, code, path) {
  if (!isJsonString(value) || value.length === 0) {
    throw new SandboxContractError(code, path);
  }
}

function assertAbsolutePath(value, code, path) {
  assertNonEmptyString(value, code, path);
  if (!value.startsWith("/") || value.includes("..")) {
    throw new SandboxContractError(code, path);
  }
}

function isNonEmptyObject(value) {
  return value && isJsonObject(value) && !Array.isArray(value) && Object.keys(value).length > 0;
}

function isInside(parent, child) {
  return child === parent || child.startsWith(`${parent.replace(/\/$/, "")}/`);
}

function isEgressCapability(interfaceName) {
  return egressCapabilityPrefixes.some((prefix) => interfaceName.startsWith(prefix));
}

function stableStringify(value) {
  if (value === null || !isJsonObject(value)) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}
