import { isJsonString, isJsonObject } from "./json.js";
export const MTLS_DATA_PATH_SCHEMA_VERSION = "hobo.mtls-data-path/v1";

const SPIFFE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const FORBIDDEN_CONTRACT_FIELDS = new Set([
  "privateKey",
  "privateKeyPem",
  "certificatePem",
  "issuerKeyRef",
  "generatedKey",
  "caPrivateKey"
]);

export function parseWorkloadSpiffeId(input, options = {}) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("SPIFFE ID must be a valid URI");
  }

  if (url.protocol !== "spiffe:") {
    throw new Error("SPIFFE ID must use the spiffe:// scheme");
  }

  const trustDomain = url.hostname;
  assertSegment(trustDomain, "SPIFFE ID trust-domain");
  const expectedTrustDomain = options.expectedTrustDomain;
  if (expectedTrustDomain !== undefined && trustDomain !== expectedTrustDomain) {
    throw new Error(`trust-domain mismatch: expected ${expectedTrustDomain}, got ${trustDomain}`);
  }

  const segments = url.pathname.split("/").slice(1);
  if (segments.length !== 2 && segments.length !== 3) {
    throw new Error(
      "SPIFFE ID must be spiffe://yard/<tenant>/<bindle>/<resource> or spiffe://<tenant>/<bindle>/<resource>"
    );
  }
  for (const segment of segments) {
    assertSegment(segment, "SPIFFE ID segment");
  }
  if (segments.length === 3 && trustDomain !== "yard") {
    throw new Error("SPIFFE ID three-segment tenant path is reserved for the yard trust-domain");
  }

  const [tenant, bindle, resource] =
    segments.length === 3 ? segments : [trustDomain, segments[0], segments[1]];
  if (options.expectedTenant && tenant !== options.expectedTenant) {
    throw new Error(`tenant mismatch: expected ${options.expectedTenant}, got ${tenant}`);
  }

  return { trustDomain, tenant, bindle, resource };
}

export function validateMtlsDataPathContract(contract) {
  if (!isPlainObject(contract)) {
    return invalid("mtls.contract.invalid", "contract must be an object");
  }

  for (const field of FORBIDDEN_CONTRACT_FIELDS) {
    if (field in contract) {
      return invalid(
        "mtls.contract.scope-out",
        "contract consumes Identity cert material and must not carry issuing/private key material"
      );
    }
  }

  if (contract.schemaVersion !== MTLS_DATA_PATH_SCHEMA_VERSION) {
    return invalid("mtls.schema.unsupported", `schemaVersion must be ${MTLS_DATA_PATH_SCHEMA_VERSION}`);
  }

  for (const [field, value] of [
    ["connectionId", contract.connectionId],
    ["tenant", contract.tenant],
    ["trustDomain", contract.trustDomain],
    ["sourceSvid", contract.sourceSvid],
    ["certMaterialRef", contract.certMaterialRef],
    ["authz.bindEdgeId", contract.authz?.bindEdgeId]
  ]) {
    if (!isNonEmptyString(value)) {
      return invalid("mtls.contract.required-field", `${field} must be a non-empty string`);
    }
  }

  if (!contract.certMaterialRef.startsWith("identity://")) {
    return invalid("mtls.cert-material.invalid", "certMaterialRef must be an identity:// reference");
  }

  if (!isPlainObject(contract.peerCertificate)) {
    return invalid("mtls.peer-cert.invalid", "peerCertificate must be an object");
  }

  for (const [field, value] of [
    ["peerCertificate.spiffeId", contract.peerCertificate.spiffeId],
    ["peerCertificate.serialNumber", contract.peerCertificate.serialNumber],
    ["peerCertificate.notBefore", contract.peerCertificate.notBefore],
    ["peerCertificate.notAfter", contract.peerCertificate.notAfter]
  ]) {
    if (!isNonEmptyString(value)) {
      return invalid("mtls.contract.required-field", `${field} must be a non-empty string`);
    }
  }

  if (!Number.isInteger(contract.peerCertificate.rotationEpoch) || contract.peerCertificate.rotationEpoch < 0) {
    return invalid("mtls.peer-cert.invalid", "peerCertificate.rotationEpoch must be a non-negative integer");
  }

  if (!Array.isArray(contract.allowedPeers) || contract.allowedPeers.length === 0) {
    return invalid("mtls.allow-list.invalid", "allowedPeers must be a non-empty array");
  }

  const seenPeers = new Set();
  for (const peer of contract.allowedPeers) {
    if (!isNonEmptyString(peer)) {
      return invalid("mtls.allow-list.invalid", "allowedPeers entries must be non-empty strings");
    }
    if (seenPeers.has(peer)) {
      return invalid("mtls.allow-list.invalid", `duplicate allowed peer ${peer}`);
    }
    seenPeers.add(peer);
  }

  if (!Array.isArray(contract.authz?.verbs) || contract.authz.verbs.length === 0) {
    return invalid("mtls.authz.invalid", "authz.verbs must be a non-empty array");
  }

  for (const verb of contract.authz.verbs) {
    if (!isNonEmptyString(verb)) {
      return invalid("mtls.authz.invalid", "authz.verbs entries must be non-empty strings");
    }
  }

  if (
    contract.minimumPeerRotationEpoch !== undefined &&
    (!Number.isInteger(contract.minimumPeerRotationEpoch) || contract.minimumPeerRotationEpoch < 0)
  ) {
    return invalid("mtls.rotation.invalid", "minimumPeerRotationEpoch must be a non-negative integer");
  }

  try {
    parseWorkloadSpiffeId(contract.sourceSvid, {
      expectedTenant: contract.tenant,
      expectedTrustDomain: contract.trustDomain
    });
    parseWorkloadSpiffeId(contract.peerCertificate.spiffeId, {
      expectedTrustDomain: contract.trustDomain
    });
    for (const peer of contract.allowedPeers) {
      parseWorkloadSpiffeId(peer, {
        expectedTrustDomain: contract.trustDomain
      });
    }
  } catch (error) {
    return invalid("mtls.spiffe.invalid", error.message);
  }

  if (!isValidDate(contract.peerCertificate.notBefore) || !isValidDate(contract.peerCertificate.notAfter)) {
    return invalid("mtls.peer-cert.invalid", "peerCertificate validity must be ISO-8601 timestamps");
  }
  if (contract.now !== undefined && !isValidDate(contract.now)) {
    return invalid("mtls.clock.invalid", "now must be an ISO-8601 timestamp when provided");
  }

  return { ok: true };
}

export function evaluateMtlsHandshake(contract) {
  const validation = validateMtlsDataPathContract(contract);
  if (!validation.ok) return validation;

  const source = parseWorkloadSpiffeId(contract.sourceSvid, {
    expectedTenant: contract.tenant,
    expectedTrustDomain: contract.trustDomain
  });
  const peer = parseWorkloadSpiffeId(contract.peerCertificate.spiffeId, {
    expectedTrustDomain: contract.trustDomain
  });

  if (peer.tenant !== contract.tenant) {
    return invalid(
      "mtls.peer.tenant-mismatch",
      `peer tenant ${peer.tenant} does not match connection tenant ${contract.tenant}`
    );
  }

  const at = new Date(contract.now ?? new Date()).getTime();
  const notBefore = new Date(contract.peerCertificate.notBefore).getTime();
  const notAfter = new Date(contract.peerCertificate.notAfter).getTime();
  if (at < notBefore || at >= notAfter) {
    return invalid("mtls.peer.svid-expired", "peer SVID is expired or not yet valid");
  }

  const minimumEpoch = contract.minimumPeerRotationEpoch ?? 0;
  if (contract.peerCertificate.rotationEpoch < minimumEpoch) {
    return invalid(
      "mtls.peer.svid-rotated",
      `peer SVID rotation epoch ${contract.peerCertificate.rotationEpoch} is older than required epoch ${minimumEpoch}`
    );
  }

  if (!contract.allowedPeers.includes(contract.peerCertificate.spiffeId)) {
    return invalid(
      "mtls.peer.not-allowed",
      `peer ${contract.peerCertificate.spiffeId} is not in the bind-derived allow-list`
    );
  }

  return {
    ok: true,
    connectionId: contract.connectionId,
    source,
    peer,
    authz: clone(contract.authz),
    certMaterialRef: contract.certMaterialRef
  };
}

function assertSegment(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${field} must not be empty`);
  }
  if (!SPIFFE_SEGMENT_PATTERN.test(value)) {
    throw new Error(`${field} contains invalid characters`);
  }
}

function isValidDate(value) {
  return !Number.isNaN(new Date(value).getTime());
}

function isPlainObject(value) {
  return (
    value !== null &&
    isJsonObject(value) &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.length > 0;
}

function invalid(code, reason) {
  return { ok: false, code, reason };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
