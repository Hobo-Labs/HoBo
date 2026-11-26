import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const SCHEMA_VERSION = "hobo.workload-attestation/v1";
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PRINCIPAL_KINDS = new Set(["user", "agent", "service", "workload"]);
const MICROVM_POLICY = Object.freeze({
  attestationState: "unattested",
  isolationFloor: "firecracker-microvm",
  nonOverridable: true,
});

export function createFixtureHostAttestor({ hostId, keyId = `${hostId}-key-1` } = {}) {
  if (!hostId) {
    throw new Error("fixture host attestor requires hostId");
  }
  const verificationKey = `fixture-host-key:${hostId}:${keyId}`;

  return {
    createDocument({ launchMeasurement, claimed = {} }) {
      const measured = clone(launchMeasurement);
      return {
        schemaVersion: SCHEMA_VERSION,
        runId: measured.runId,
        claimed: clone(claimed),
        launchMeasurement: measured,
        hostSignature: {
          algorithm: "fixture-hmac-sha256",
          hostId,
          keyId,
          value: signLaunchMeasurement(measured, verificationKey),
        },
      };
    },
    publicKeys() {
      return [{ hostId, keyId, verificationKey }];
    },
  };
}

export function verifyWorkloadAttestation(document, options = {}) {
  const requestedIsolationTier = options.requestedIsolationTier;
  const fail = (reason) => unattested(reason, requestedIsolationTier);

  if (!isPlainObject(document)) {
    return fail("attestation-document-invalid");
  }
  if (document.schemaVersion !== SCHEMA_VERSION) {
    return fail("attestation-document-invalid");
  }
  if (!isPlainObject(document.launchMeasurement)) {
    return fail("launch-measurement-invalid");
  }

  const measurement = document.launchMeasurement;
  const measurementError = validateLaunchMeasurement(measurement);
  if (measurementError) {
    return fail(measurementError);
  }

  if (document.runId !== measurement.runId) {
    return fail("run-id-mismatch");
  }
  if (!document.hostSignature) {
    return fail("host-signature-missing");
  }
  if (!verifyHostSignature(measurement, document.hostSignature, options.hostPublicKeys ?? [])) {
    return fail("host-signature-invalid");
  }

  const nowMs = Date.parse(options.now ?? new Date().toISOString());
  if (Date.parse(measurement.issuedAt) > nowMs) {
    return fail("launch-measurement-not-yet-valid");
  }
  if (Date.parse(measurement.expiresAt) <= nowMs) {
    return fail("launch-measurement-expired");
  }

  const knownDigests = new Set(options.knownImageDigests ?? []);
  if (!knownDigests.has(measurement.componentImageDigest)) {
    return fail("unknown-component-image");
  }

  const verdict = {
    state: "attested",
    reason: "host-signature-valid",
    binding: {
      runId: measurement.runId,
      tenant: measurement.tenant,
      parentPrincipal: clone(measurement.parentPrincipal),
      codeVersion: clone(measurement.codeVersion),
      componentImageDigest: measurement.componentImageDigest,
    },
    evidence: {
      hostId: measurement.hostId,
      launchMeasurementDigest: digestCanonical(measurement),
    },
    policy: {
      attestationState: "attested",
      isolationFloor: "workload-selected",
      nonOverridable: false,
    },
  };

  const claimConflict = detectClaimConflict(document.claimed, measurement);
  if (claimConflict) {
    verdict.claimConflict = claimConflict;
  }

  return deepFreeze(verdict);
}

function verifyHostSignature(measurement, signature, hostPublicKeys) {
  if (!isPlainObject(signature)) {
    return false;
  }
  if (signature.algorithm !== "fixture-hmac-sha256") {
    return false;
  }
  const key = hostPublicKeys.find(
    (entry) =>
      entry.hostId === measurement.hostId &&
      entry.hostId === signature.hostId &&
      entry.keyId === signature.keyId &&
      isString(entry.verificationKey),
  );
  if (!key) {
    return false;
  }

  const expected = signLaunchMeasurement(measurement, key.verificationKey);
  return safeEqualBase64url(expected, signature.value);
}

function signLaunchMeasurement(measurement, verificationKey) {
  return createHmac("sha256", verificationKey)
    .update(canonicalJson(measurement))
    .digest("base64url");
}

function validateLaunchMeasurement(measurement) {
  for (const field of ["runId", "tenant", "componentImageDigest", "hostId", "nonce", "isolationTier"]) {
    if (!isString(measurement[field]) || measurement[field].length === 0) {
      return "launch-measurement-invalid";
    }
  }
  if (!DIGEST_PATTERN.test(measurement.componentImageDigest)) {
    return "launch-measurement-invalid";
  }
  if (!isPrincipal(measurement.parentPrincipal)) {
    return "launch-measurement-invalid";
  }
  if (!isPlainObject(measurement.codeVersion) || !DIGEST_PATTERN.test(measurement.codeVersion.digest ?? "")) {
    return "launch-measurement-invalid";
  }
  if (!ISO_PATTERN.test(measurement.issuedAt ?? "") || Number.isNaN(Date.parse(measurement.issuedAt))) {
    return "launch-measurement-invalid";
  }
  if (!ISO_PATTERN.test(measurement.expiresAt ?? "") || Number.isNaN(Date.parse(measurement.expiresAt))) {
    return "launch-measurement-invalid";
  }
  return null;
}

function detectClaimConflict(claimed, measurement) {
  if (!isPlainObject(claimed)) {
    return null;
  }

  const conflicts = {};
  if (claimed.tenant !== undefined && claimed.tenant !== measurement.tenant) {
    conflicts.tenant = { claimed: claimed.tenant, measured: measurement.tenant };
  }
  if (
    claimed.parentPrincipal !== undefined &&
    canonicalJson(claimed.parentPrincipal) !== canonicalJson(measurement.parentPrincipal)
  ) {
    conflicts.parentPrincipal = {
      claimed: clone(claimed.parentPrincipal),
      measured: clone(measurement.parentPrincipal),
    };
  }

  return Object.keys(conflicts).length ? conflicts : null;
}

function unattested(reason, requestedIsolationTier) {
  const verdict = {
    state: "unattested",
    reason,
    policy: MICROVM_POLICY,
  };
  if (requestedIsolationTier !== undefined) {
    verdict.requestedIsolationTier = requestedIsolationTier;
  }
  return deepFreeze(verdict);
}

function digestCanonical(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value) {
  return JSON.stringify(sortForCanonicalJson(value));
}

function sortForCanonicalJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortForCanonicalJson);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortForCanonicalJson(value[key])]),
  );
}

function safeEqualBase64url(left, right) {
  if (!isString(right)) {
    return false;
  }
  try {
    const leftBytes = Buffer.from(left, "base64url");
    const rightBytes = Buffer.from(right, "base64url");
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
  } catch {
    return false;
  }
}

function isPrincipal(value) {
  return (
    isPlainObject(value) &&
    PRINCIPAL_KINDS.has(value.kind) &&
    isString(value.id) &&
    value.id.length > 0
  );
}

function isPlainObject(value) {
  return (
    value !== null &&
    isObjectRecord(value) &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!isObjectRecord(value) || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function isObjectRecord(value) {
  return value !== null && Object.prototype.toString.call(value) === "[object Object]";
}

function isString(value) {
  return Object.prototype.toString.call(value) === "[object String]";
}
