import { isJsonString, isJsonObject } from "./json.js";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";

export const POLICY_ENGINE_MEASUREMENT_SCHEMA = "hobo.policy-engine-measurement/v1";
export const POLICY_ENGINE_ATTESTATION_SCHEMA = "hobo.policy-engine-build-attestation/v1";
export const SIGNED_DECISION_LOG_SCHEMA = "hobo.signed-decision-log/v1";
export const SIGNATURE_ALGORITHM = "ed25519";

export function createFixtureAttestationTrust() {
  const engineAttestor = createSigningKey("attestor:hobo-release");
  const decisionLogSigner = createSigningKey("decision-log:hobo-management-plane");

  return {
    sharedTrustRootId: "trust-root:hobo-shared-prod",
    trustedTrustRoots: ["trust-root:hobo-shared-prod"],
    engineAttestor,
    decisionLogSigner,
    attestationKeys: engineAttestor.trustStore,
    decisionLogKeys: decisionLogSigner.trustStore
  };
}

export function measurePolicyEngineBuild({
  name,
  version,
  binaryDigest,
  conformanceDigest,
  behavior = "fail-closed"
}) {
  const measurement = {
    schemaVersion: POLICY_ENGINE_MEASUREMENT_SCHEMA,
    name: requiredString(name, "name"),
    version: requiredString(version, "version"),
    binaryDigest: requiredDigest(binaryDigest, "binaryDigest"),
    conformanceDigest: requiredDigest(conformanceDigest, "conformanceDigest"),
    behavior: requiredString(behavior, "behavior")
  };

  return {
    ...measurement,
    digest: digestObject(measurement)
  };
}

export function attestPolicyEngineBuild({ yardId, measurement, trustRootId, signer, issuedAt }) {
  const parsedMeasurement = parseMeasurement(measurement);
  const payload = {
    schemaVersion: POLICY_ENGINE_ATTESTATION_SCHEMA,
    yardId: requiredString(yardId, "yardId"),
    trustRootId: requiredString(trustRootId, "trustRootId"),
    engineDigest: parsedMeasurement.digest,
    measurement: parsedMeasurement,
    issuedAt: requiredTimestamp(issuedAt, "issuedAt")
  };

  return {
    schemaVersion: POLICY_ENGINE_ATTESTATION_SCHEMA,
    payload,
    signature: signPayload(payload, signer)
  };
}

export function signDecisionLog({
  yardId,
  trustRootId,
  engineDigest,
  decisions,
  signer,
  observedAt,
  sequence = 1
}) {
  const payload = {
    schemaVersion: SIGNED_DECISION_LOG_SCHEMA,
    yardId: requiredString(yardId, "yardId"),
    trustRootId: requiredString(trustRootId, "trustRootId"),
    engineDigest: requiredDigest(engineDigest, "engineDigest"),
    observedAt: requiredTimestamp(observedAt, "observedAt"),
    sequence: requiredFiniteNumber(sequence, "sequence"),
    decisions: parseDecisions(decisions)
  };

  return {
    schemaVersion: SIGNED_DECISION_LOG_SCHEMA,
    payload,
    signature: signPayload(payload, signer)
  };
}

export function reconcileYardPolicyAttestations({
  expectedEngineDigests,
  trust,
  yards,
  now,
  maxDecisionLogGapMs
}) {
  const expectedDigests = new Set(parseStringList(expectedEngineDigests, "expectedEngineDigests"));
  const nowMs = Date.parse(requiredTimestamp(now, "now"));
  const maxGapMs = requiredFiniteNumber(maxDecisionLogGapMs, "maxDecisionLogGapMs");
  const yardStatuses = [];
  const signals = [];
  const managementPlaneLog = [];

  for (const yard of parseYards(yards)) {
    const yardSignals = [];
    const add = (type, reason) => {
      const signal = { type, yardId: yard.yardId, severity: "policy-violation", reason };
      yardSignals.push(signal);
      signals.push(signal);
    };

    const attestation = verifyEngineAttestation(yard.attestation, trust);
    if (!attestation.ok) {
      add("policy.ForgedAttestation", attestation.error);
    } else {
      if (attestation.payload.yardId !== yard.yardId) {
        add("policy.AttestationMismatch", "policy-engine attestation yardId does not match submitted Yard");
      }
      if (!trust?.trustedTrustRoots?.includes(attestation.payload.trustRootId)) {
        add("policy.OutsideTrustRoot", "Yard is outside shared trust root");
      }
      if (!expectedDigests.has(attestation.payload.engineDigest)) {
        add("policy.AttestationMismatch", "policy-engine build measurement does not match expected build");
      }
    }

    const verifiedLogs = [];
    for (const log of yard.decisionLogs) {
      const logResult = verifyDecisionLog(log, trust);
      if (!logResult.ok) {
        add("policy.DecisionLogInvalid", logResult.error);
        continue;
      }

      const payload = logResult.payload;
      if (payload.yardId !== yard.yardId) {
        add("policy.DecisionLogInvalid", "decision log yardId does not match submitted Yard");
        continue;
      }
      if (!trust?.trustedTrustRoots?.includes(payload.trustRootId)) {
        add("policy.OutsideTrustRoot", "decision log is outside shared trust root");
      }
      if (attestation.ok && payload.engineDigest !== attestation.payload.engineDigest) {
        add("policy.DecisionLogEngineMismatch", "decision log engineDigest differs from attested engine");
      }

      verifiedLogs.push(payload);
      for (const decision of payload.decisions) {
        managementPlaneLog.push({
          type: "policy.Decided",
          yardId: payload.yardId,
          trustRootId: payload.trustRootId,
          engineDigest: payload.engineDigest,
          observedAt: payload.observedAt,
          sequence: payload.sequence,
          decisionId: decision.decisionId,
          policyId: decision.policyId,
          effect: decision.effect,
          resource: decision.resource,
          subject: decision.subject,
          sourceLogDigest: digestObject(payload)
        });
      }
    }

    if (verifiedLogs.length === 0) {
      add("policy.AttestationGap", "Yard shipped no verified decision logs");
    } else {
      const gap = firstSequenceGap(verifiedLogs.map((log) => log.sequence));
      if (gap !== undefined) {
        add("policy.AttestationGap", `Yard decision log stream skipped sequence ${gap}`);
      }
      const latestObservedMs = Math.max(...verifiedLogs.map((log) => Date.parse(log.observedAt)));
      if (nowMs - latestObservedMs > maxGapMs) {
        add("policy.AttestationGap", "Yard decision log stream exceeded maximum freshness window");
      }
    }

    yardStatuses.push({
      yardId: yard.yardId,
      guarantee: yardSignals.length === 0 ? "inside-shared-trust-root" : "outside-guarantee",
      engineDigest: attestation.ok ? attestation.payload.engineDigest : undefined,
      signals: yardSignals.map((signal) => signal.type)
    });
  }

  return {
    yardStatuses,
    signals,
    managementPlaneLog
  };
}

export function doctorYardPolicyGuarantee(reconciliation, yardId) {
  const status = reconciliation?.yardStatuses?.find((entry) => entry.yardId === yardId);
  if (!status) {
    return {
      yardId,
      guarantee: "outside-guarantee",
      summary: `${yardId} has no reconciled policy attestation evidence`,
      signals: ["policy.AttestationGap"]
    };
  }

  if (status.guarantee === "inside-shared-trust-root") {
    return {
      yardId,
      guarantee: status.guarantee,
      summary: `${yardId} is inside the shared trust root and policy guarantee`,
      signals: []
    };
  }

  const summary = status.signals.includes("policy.OutsideTrustRoot")
    ? `${yardId} is outside shared trust root; policy guarantee does not apply`
    : `${yardId} is outside policy guarantee: ${status.signals.join(", ")}`;

  return {
    yardId,
    guarantee: "outside-guarantee",
    summary,
    signals: status.signals
  };
}

function verifyEngineAttestation(attestation, trust) {
  try {
    if (!isPlainObject(attestation)) {
      throw new TypeError("policy-engine attestation must be an object");
    }
    if (attestation.schemaVersion !== POLICY_ENGINE_ATTESTATION_SCHEMA) {
      throw new TypeError(`schemaVersion must be ${POLICY_ENGINE_ATTESTATION_SCHEMA}`);
    }
    const payload = requiredObject(attestation.payload, "payload");
    verifySignedPayload({
      payload,
      signature: attestation.signature,
      keys: trust?.attestationKeys,
      missingMessage: "policy-engine attestation signature missing",
      failedMessage: "policy-engine attestation signature verification failed"
    });
    if (payload.schemaVersion !== POLICY_ENGINE_ATTESTATION_SCHEMA) {
      throw new TypeError(`payload.schemaVersion must be ${POLICY_ENGINE_ATTESTATION_SCHEMA}`);
    }
    const measurement = parseMeasurement(payload.measurement);
    if (payload.engineDigest !== measurement.digest) {
      throw new TypeError("policy-engine attestation subject digest mismatch");
    }
    requiredString(payload.yardId, "payload.yardId");
    requiredString(payload.trustRootId, "payload.trustRootId");
    requiredTimestamp(payload.issuedAt, "payload.issuedAt");

    return {
      ok: true,
      payload: clone(payload)
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message
    };
  }
}

function verifyDecisionLog(log, trust) {
  try {
    if (!isPlainObject(log)) {
      throw new TypeError("decision log must be an object");
    }
    if (log.schemaVersion !== SIGNED_DECISION_LOG_SCHEMA) {
      throw new TypeError(`schemaVersion must be ${SIGNED_DECISION_LOG_SCHEMA}`);
    }
    const payload = requiredObject(log.payload, "payload");
    verifySignedPayload({
      payload,
      signature: log.signature,
      keys: trust?.decisionLogKeys,
      missingMessage: "decision log signature missing",
      failedMessage: "decision log signature verification failed"
    });
    if (payload.schemaVersion !== SIGNED_DECISION_LOG_SCHEMA) {
      throw new TypeError(`payload.schemaVersion must be ${SIGNED_DECISION_LOG_SCHEMA}`);
    }
    requiredString(payload.yardId, "payload.yardId");
    requiredString(payload.trustRootId, "payload.trustRootId");
    requiredDigest(payload.engineDigest, "payload.engineDigest");
    requiredTimestamp(payload.observedAt, "payload.observedAt");
    requiredFiniteNumber(payload.sequence, "payload.sequence");
    parseDecisions(payload.decisions);

    return {
      ok: true,
      payload: clone(payload)
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message
    };
  }
}

function parseMeasurement(measurement) {
  const value = requiredObject(measurement, "measurement");
  if (value.schemaVersion !== POLICY_ENGINE_MEASUREMENT_SCHEMA) {
    throw new TypeError(`measurement.schemaVersion must be ${POLICY_ENGINE_MEASUREMENT_SCHEMA}`);
  }
  const parsed = {
    schemaVersion: POLICY_ENGINE_MEASUREMENT_SCHEMA,
    name: requiredString(value.name, "measurement.name"),
    version: requiredString(value.version, "measurement.version"),
    binaryDigest: requiredDigest(value.binaryDigest, "measurement.binaryDigest"),
    conformanceDigest: requiredDigest(value.conformanceDigest, "measurement.conformanceDigest"),
    behavior: requiredString(value.behavior, "measurement.behavior")
  };
  const digest = digestObject(parsed);
  if (value.digest !== digest) {
    throw new TypeError("measurement digest does not match measured policy-engine build");
  }

  return {
    ...parsed,
    digest
  };
}

function parseDecisions(decisions) {
  if (!Array.isArray(decisions) || decisions.length === 0) {
    throw new TypeError("decisions must be a non-empty array");
  }

  return decisions.map((decision, index) => {
    const value = requiredObject(decision, `decisions[${index}]`);
    return {
      decisionId: requiredString(value.decisionId, `decisions[${index}].decisionId`),
      policyId: requiredString(value.policyId, `decisions[${index}].policyId`),
      effect: requiredString(value.effect, `decisions[${index}].effect`),
      resource: requiredString(value.resource, `decisions[${index}].resource`),
      subject: requiredString(value.subject, `decisions[${index}].subject`)
    };
  });
}

function parseYards(yards) {
  if (!Array.isArray(yards) || yards.length === 0) {
    throw new TypeError("yards must be a non-empty array");
  }

  return yards.map((yard, index) => {
    const value = requiredObject(yard, `yards[${index}]`);
    return {
      yardId: requiredString(value.yardId, `yards[${index}].yardId`),
      attestation: value.attestation,
      decisionLogs: Array.isArray(value.decisionLogs) ? value.decisionLogs : []
    };
  });
}

function firstSequenceGap(sequences) {
  const sorted = [...new Set(sequences)].sort((left, right) => left - right);
  for (let index = 0; index < sorted.length; index += 1) {
    const expected = index + 1;
    if (sorted[index] !== expected) {
      return expected;
    }
  }
  return undefined;
}

function verifySignedPayload({ payload, signature, keys, missingMessage, failedMessage }) {
  if (!isPlainObject(signature)) {
    throw new TypeError(missingMessage);
  }
  if (signature.alg !== SIGNATURE_ALGORITHM) {
    throw new TypeError(`signature.alg must be ${SIGNATURE_ALGORITHM}`);
  }
  const keyId = requiredString(signature.keyId, "signature.keyId");
  const trustedKey = keys?.[keyId];
  if (!trustedKey) {
    throw new TypeError(`no trusted key for ${keyId}`);
  }
  const signatureOk = verify(
    null,
    Buffer.from(canonicalJson(payload)),
    trustedKey,
    Buffer.from(requiredString(signature.value, "signature.value"), "base64url")
  );
  if (!signatureOk) {
    throw new TypeError(failedMessage);
  }
}

function signPayload(payload, signer) {
  const { keyId, privateKey } = signer ;
  return {
    alg: SIGNATURE_ALGORITHM,
    keyId: requiredString(keyId, "signer.keyId"),
    value: sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString("base64url")
  };
}

function createSigningKey(keyId) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    keyId,
    privateKey,
    publicKey,
    trustStore: {
      [keyId]: publicKey
    }
  };
}

function parseStringList(values, path) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError(`${path} must be a non-empty array`);
  }

  return values.map((value, index) => requiredString(value, `${path}[${index}]`));
}

function requiredDigest(value, path) {
  const parsed = requiredString(value, path);
  if (!parsed.startsWith("sha256:")) {
    throw new TypeError(`${path} must be a sha256 digest`);
  }
  return parsed;
}

function requiredTimestamp(value, path) {
  const parsed = requiredString(value, path);
  if (Number.isNaN(Date.parse(parsed))) {
    throw new TypeError(`${path} must be an ISO-8601 timestamp`);
  }
  return parsed;
}

function requiredFiniteNumber(value, path) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${path} must be finite`);
  }
  return value;
}

function requiredObject(value, path) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value;
}

function requiredString(value, path) {
  if (!isJsonString(value) || value.trim() === "") {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

function digestObject(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function clone(value) {
  return structuredClone(value);
}

function isPlainObject(value) {
  return (
    value !== null &&
    isJsonObject(value) &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
