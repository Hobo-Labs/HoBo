import {
  createHash,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
} from "node:crypto";

import {
  createIdentityEvent,
  validateIdentityEvent,
} from "../../identity-event-contract/src/identity-event-contract.js";
import { isJsonString, isJsonNumber, isJsonObject } from "./json.js";


const DEFAULT_TTL_SECONDS = 5 * 60;
const DEFAULT_ROTATE_BEFORE_SECONDS = 2 * 60;
const DEFAULT_OVERLAP_SECONDS = 30;
const DEFAULT_SKEW_TOLERANCE_SECONDS = 5;
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const SIGNING_ALGORITHM = "RSA-SHA256";
const X509_SVID_VERSION = "hobo.x509-svid/v1";
const workloadPrivateKeys = new WeakMap();

export function createX509SvidAuthority(options = {}) {
  const trustDomain = requireSegment(options.trustDomain ?? "yard", "trustDomain");
  const ttlSeconds = positiveInteger(options.ttlSeconds ?? DEFAULT_TTL_SECONDS, "ttlSeconds");
  const rotateBeforeSeconds = positiveInteger(
    options.rotateBeforeSeconds ?? DEFAULT_ROTATE_BEFORE_SECONDS,
    "rotateBeforeSeconds",
  );
  const overlapSeconds = nonNegativeInteger(
    options.overlapSeconds ?? DEFAULT_OVERLAP_SECONDS,
    "overlapSeconds",
  );
  const skewToleranceSeconds = nonNegativeInteger(
    options.skewToleranceSeconds ?? DEFAULT_SKEW_TOLERANCE_SECONDS,
    "skewToleranceSeconds",
  );
  const mode = options.mode ?? "online";
  if (!["online", "airgap"].includes(mode)) {
    throw new Error("mode must be online or airgap");
  }

  const fixedNow = options.now;
  const now = options.clock ?? (() => new Date(fixedNow ?? Date.now()));
  const idFactory = options.idFactory ?? defaultIdFactory("x509-svid");
  const eventSink = options.eventSink ?? (() => {});
  const tenantCas = new Map();
  const retiredSvidRefs = new Map();

  function profile() {
    return deepFreeze({
      trustDomain,
      mode,
      caPath: mode === "airgap" ? "internal-ca/private-acme" : "svid-ca/kms",
      phoneHomeRequired: mode !== "airgap",
    });
  }

  function ensureTenantCa(tenant) {
    const normalizedTenant = requireSegment(tenant, "tenant");
    const existing = tenantCas.get(normalizedTenant);
    if (existing) {
      return existing;
    }

    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicJwk = publicKey.export({ format: "jwk" });
    const ca = {
      tenant: normalizedTenant,
      privateKey,
      publicKey,
      publicJwk: { ...publicJwk, kid: `svid-ca-${normalizedTenant}`, alg: "RS256", use: "sig" },
      fingerprint: fingerprintJwk(publicJwk),
    };
    tenantCas.set(normalizedTenant, ca);
    return ca;
  }

  function issueWorkloadSvid(input) {
    const request = normalizeIssueRequest(input, trustDomain);
    const issuedAt = coerceTimeMs(request.now ?? now(), "now");
    const notBefore = issuedAt;
    const notAfter = issuedAt + ttlSeconds * 1000;
    const ca = ensureTenantCa(request.tenant);
    const spiffeId = buildSpiffeId({
      trustDomain,
      tenant: request.tenant,
      bindle: request.bindle,
      resource: request.resource,
    });
    if (request.requestedSpiffeId && request.requestedSpiffeId !== spiffeId) {
      throw new Error("requested SPIFFE ID outside tenant trust domain or attested workload");
    }

    const identityId = idFactory("x509-svid");
    const svidRef = `identity://x509-svid/${identityId}`;
    const keyRef = `identity://workload-key/${identityId}`;
    const {
      privateKey: workloadPrivateKey,
      publicKey: workloadPublicKey,
    } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const certificateBody = {
      version: X509_SVID_VERSION,
      serialNumber: identityId,
      subject: {
        commonName: `${request.bindle}/${request.resource}`,
        spiffeId,
      },
      issuer: {
        trustDomain,
        tenant: request.tenant,
        caFingerprint: ca.fingerprint,
        caPath: profile().caPath,
      },
      x509: {
        subjectAltName: {
          uris: [spiffeId],
        },
        extendedKeyUsage: ["clientAuth", "serverAuth"],
      },
      publicKeyJwk: workloadPublicKey.export({ format: "jwk" }),
      notBefore,
      notAfter,
      issuedAt: new Date(issuedAt).toISOString(),
    };
    const signature = signCertificateBody(ca.privateKey, certificateBody);
    const certificate = deepFreeze({
      ...certificateBody,
      signature: {
        algorithm: "RS256",
        caFingerprint: ca.fingerprint,
        value: signature,
      },
    });
    const event = buildIdentityEvent({
      type: "identity.Issued",
      identityId,
      subject: spiffeId,
      svidRef,
      scope: [mtlsScope(spiffeId)],
      expiresAt: new Date(notAfter).toISOString(),
      time: new Date(issuedAt).toISOString(),
      tenant: request.tenant,
      caPath: profile().caPath,
    });
    eventSink(event);

    const issued = deepFreeze({
      identityId,
      svidRef,
      spiffeId,
      tenant: request.tenant,
      certificate,
      delivery: {
        channel: "identity.workload-svid",
        keyRef,
        appManaged: false,
      },
      events: [event],
    });
    workloadPrivateKeys.set(issued, workloadPrivateKey);
    return issued;
  }

  function trustBundle(options = {}) {
    const tenant = options.tenant === undefined
      ? undefined
      : requireSegment(options.tenant, "tenant");
    if (tenant) {
      ensureTenantCa(tenant);
    }

    const entries = [...tenantCas.values()]
      .filter((ca) => tenant === undefined || ca.tenant === tenant)
      .map((ca) => [
        ca.tenant,
        {
          tenant: ca.tenant,
          caFingerprint: ca.fingerprint,
          caPublicKeyJwk: clone(ca.publicJwk),
        },
      ]);

    return deepFreeze({
      trustDomain,
      expectedTenant: tenant,
      caPath: profile().caPath,
      phoneHomeRequired: profile().phoneHomeRequired,
      tenantCas: Object.fromEntries(entries),
      retiredSvidRefs: Object.fromEntries(retiredSvidRefs),
    });
  }

  function retireSvidAfterOverlap(svidRef, acceptedUntil) {
    retiredSvidRefs.set(
      requireString(svidRef, "svidRef"),
      coerceTimeMs(acceptedUntil, "acceptedUntil"),
    );
  }

  return deepFreeze({
    trustDomain,
    ttlSeconds,
    rotateBeforeSeconds,
    overlapSeconds,
    skewToleranceSeconds,
    profile,
    issueWorkloadSvid,
    trustBundle,
    retireSvidAfterOverlap,
  });
}

export function rotateX509Svid({ authority, current, attestation, now }) {
  if (!authority || !(authority.issueWorkloadSvid instanceof Function)) {
    throw new Error("rotateX509Svid requires an X.509-SVID authority");
  }
  const atMs = coerceTimeMs(now ?? Date.now(), "now");
  const secondsUntilExpiry = Math.floor((current.certificate.notAfter - atMs) / 1000);
  if (secondsUntilExpiry <= 0) {
    throw new Error("current certificate expired before rotation");
  }
  if (secondsUntilExpiry > authority.rotateBeforeSeconds) {
    return deepFreeze({
      rotated: false,
      reason: "rotation-not-due",
      secondsUntilExpiry,
      events: [],
    });
  }

  const identity = parseSpiffeId(current.spiffeId, {
    expectedTrustDomain: authority.trustDomain,
  });
  const next = authority.issueWorkloadSvid({
    tenant: identity.tenant,
    bindle: identity.bindle,
    resource: identity.resource,
    attestation,
    requestedSpiffeId: current.spiffeId,
    now: atMs - authority.skewToleranceSeconds * 1000,
  });
  const previousAcceptedUntil = Math.min(
    current.certificate.notAfter,
    atMs + authority.overlapSeconds * 1000,
  );
  authority.retireSvidAfterOverlap(current.svidRef, previousAcceptedUntil);
  const event = buildIdentityEvent({
    type: "identity.Rotated",
    identityId: next.identityId,
    previousIdentityId: current.identityId,
    subject: next.spiffeId,
    svidRef: next.svidRef,
    previousSvidRef: current.svidRef,
    scope: [mtlsScope(next.spiffeId)],
    expiresAt: new Date(next.certificate.notAfter).toISOString(),
    time: new Date(atMs).toISOString(),
    tenant: identity.tenant,
    caPath: authority.profile().caPath,
    previousValidUntil: new Date(previousAcceptedUntil).toISOString(),
  });

  return deepFreeze({
    rotated: true,
    current,
    next,
    previousAcceptedUntil,
    gapFree: previousAcceptedUntil >= next.certificate.notBefore,
    events: [event],
  });
}

export function establishMutualTls({ client, server, trustBundle, expectedTenant, now, autoRotate }) {
  const atMs = coerceTimeMs(now ?? Date.now(), "now");
  const clientState = maybeAutoRotatePeer({
    role: "client",
    svid: client,
    autoRotate,
    now: atMs,
  });
  const serverState = maybeAutoRotatePeer({
    role: "server",
    svid: server,
    autoRotate,
    now: atMs,
  });
  const clientIdentity = verifySvid(clientState.svid, {
    trustBundle,
    expectedTenant,
    now: atMs,
    role: "client",
  });
  const serverIdentity = verifySvid(serverState.svid, {
    trustBundle,
    expectedTenant: expectedTenant ?? clientIdentity.tenant,
    now: atMs,
    role: "server",
  });

  return deepFreeze({
    ok: true,
    clientSpiffeId: clientIdentity.spiffeId,
    serverSpiffeId: serverIdentity.spiffeId,
    clientTenant: clientIdentity.tenant,
    serverTenant: serverIdentity.tenant,
    clientSvidRef: clientState.svid.svidRef,
    serverSvidRef: serverState.svid.svidRef,
    rotations: {
      client: clientState.rotation,
      server: serverState.rotation,
    },
    remainsEstablishedAfter(rotation) {
      if (!rotation?.rotated) {
        return { ok: true, reason: "no-rotation" };
      }
      return {
        ok: rotation.gapFree === true && rotation.previousAcceptedUntil >= rotation.next.certificate.notBefore,
        reason: rotation.gapFree === true ? "rotation-overlap-held" : "rotation-gap",
      };
    },
  });
}

function maybeAutoRotatePeer({ role, svid, autoRotate, now }) {
  const noRotation = deepFreeze({
    rotated: false,
    reason: "auto-rotation-disabled",
    events: [],
  });
  if (!autoRotate) {
    return { svid, rotation: noRotation };
  }
  const authority = autoRotate.authority;
  const attestation = autoRotate.attestations?.[role];
  if (!authority || !attestation) {
    return { svid, rotation: noRotation };
  }
  const rotation = rotateX509Svid({
    authority,
    current: svid,
    attestation,
    now,
  });
  return {
    svid: rotation.rotated ? rotation.next : svid,
    rotation,
  };
}

export function tamperSvidSan(svid, replacementSpiffeId) {
  const copy = clone(svid);
  copy.spiffeId = replacementSpiffeId;
  copy.certificate.subject.spiffeId = replacementSpiffeId;
  copy.certificate.x509.subjectAltName.uris = [replacementSpiffeId];
  return deepFreeze(copy);
}

function verifySvid(svid, { trustBundle, expectedTenant, now, role }) {
  if (!svid?.certificate) {
    throw new Error(`${role} SVID certificate is required`);
  }
  const certificate = svid.certificate;
  const spiffeId = firstSanUri(certificate);
  const identity = parseSpiffeId(spiffeId, {
    expectedTrustDomain: trustBundle.trustDomain,
  });
  const bundleExpectedTenant = expectedTenant ?? trustBundle.expectedTenant;
  if (bundleExpectedTenant && identity.tenant !== bundleExpectedTenant) {
    throw new Error("tenant trust-domain mismatch");
  }

  if (now < certificate.notBefore) {
    throw new Error("certificate not yet valid");
  }
  if (now > certificate.notAfter) {
    throw new Error("certificate expired");
  }
  const retiredAt = trustBundle.retiredSvidRefs?.[svid.svidRef];
  if (retiredAt !== undefined && now > retiredAt) {
    throw new Error("certificate past rotation window");
  }

  const tenantCa = trustBundle.tenantCas?.[identity.tenant];
  if (!tenantCa) {
    throw new Error("tenant trust-domain mismatch");
  }
  if (certificate.issuer.caFingerprint !== tenantCa.caFingerprint) {
    throw new Error("SVID-CA trust bundle mismatch");
  }

  const { signature, ...body } = certificate;
  if (
    !signature ||
    signature.caFingerprint !== tenantCa.caFingerprint ||
    !verifyCertificateBody(tenantCa.caPublicKeyJwk, body, signature.value)
  ) {
    throw new Error("SVID-CA signature verification failed");
  }
  if (certificate.subject.spiffeId !== spiffeId) {
    throw new Error("certificate subject does not match SAN SPIFFE ID");
  }
  verifyPrivateKeyProof(svid, certificate, spiffeId, role);

  return {
    spiffeId,
    trustDomain: identity.trustDomain,
    tenant: identity.tenant,
    bindle: identity.bindle,
    resource: identity.resource,
  };
}

function verifyPrivateKeyProof(svid, certificate, spiffeId, role) {
  const privateKey = workloadPrivateKeys.get(svid);
  if (!privateKey) {
    throw new Error("private key proof required");
  }
  const proof = {
    role,
    svidRef: svid.svidRef,
    spiffeId,
    serialNumber: certificate.serialNumber,
    notBefore: certificate.notBefore,
    notAfter: certificate.notAfter,
  };
  const signature = createSign(SIGNING_ALGORITHM)
    .update(stableStringify(proof))
    .end()
    .sign(privateKey, "base64url");
  const ok = createVerify(SIGNING_ALGORITHM)
    .update(stableStringify(proof))
    .end()
    .verify(
      createPublicKey({ key: certificate.publicKeyJwk, format: "jwk" }),
      signature,
      "base64url",
    );
  if (!ok) {
    throw new Error("private key proof failed");
  }
}

function normalizeIssueRequest(input, trustDomain) {
  if (!isPlainObject(input)) {
    throw new Error("X.509-SVID issuance request must be an object");
  }
  const tenant = requireSegment(input.tenant, "tenant");
  const bindle = requireSegment(input.bindle, "bindle");
  const resource = requireSegment(input.resource, "resource");
  const attestation = normalizeAttestation(input.attestation);
  if (
    attestation.tenant !== tenant ||
    attestation.bindle !== bindle ||
    attestation.resource !== resource
  ) {
    throw new Error("attestation binding does not match requested workload");
  }

  if (input.requestedSpiffeId !== undefined) {
    const requested = parseSpiffeId(input.requestedSpiffeId, {
      expectedTrustDomain: trustDomain,
    });
    if (
      requested.tenant !== tenant ||
      requested.bindle !== bindle ||
      requested.resource !== resource
    ) {
      throw new Error("requested SPIFFE ID outside tenant trust domain or attested workload");
    }
  }

  return {
    tenant,
    bindle,
    resource,
    attestation,
    requestedSpiffeId: input.requestedSpiffeId,
    now: input.now,
  };
}

function normalizeAttestation(attestation) {
  if (!isPlainObject(attestation)) {
    throw new Error("attestation must be an object");
  }
  const measurement = requireString(attestation.measurement, "attestation.measurement");
  if (!/^sha256:[a-f0-9]{64}$/.test(measurement)) {
    throw new Error("attestation.measurement must be sha256:<64 lowercase hex chars>");
  }
  return {
    tenant: requireSegment(attestation.tenant, "attestation.tenant"),
    bindle: requireSegment(attestation.bindle, "attestation.bindle"),
    resource: requireSegment(attestation.resource, "attestation.resource"),
    measurement,
  };
}

function parseSpiffeId(input, options = {}) {
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
  if (options.expectedTrustDomain && trustDomain !== options.expectedTrustDomain) {
    throw new Error("SPIFFE ID trust-domain mismatch");
  }
  const segments = url.pathname.split("/").slice(1);
  if (segments.length !== 3) {
    throw new Error("SPIFFE ID must be spiffe://<trust-domain>/<tenant>/<bindle>/<resource>");
  }
  const [tenant, bindle, resource] = segments.map((segment) =>
    requireSegment(segment, "SPIFFE ID segment"),
  );
  return { trustDomain, tenant, bindle, resource };
}

function buildSpiffeId({ trustDomain, tenant, bindle, resource }) {
  return `spiffe://${trustDomain}/${tenant}/${bindle}/${resource}`;
}

function buildIdentityEvent({
  type,
  identityId,
  previousIdentityId,
  subject,
  svidRef,
  previousSvidRef,
  scope,
  expiresAt,
  time,
  tenant,
  caPath,
  previousValidUntil,
}) {
  const event = createIdentityEvent(
    type,
    {
      identityId,
      ...(previousIdentityId ? { previousIdentityId } : undefined),
      subject: { kind: "service", id: subject },
      svidRef,
      ...(previousSvidRef ? { previousSvidRef } : undefined),
      scope: clone(scope),
      expiresAt,
      caPath,
      ...(previousValidUntil ? { previousValidUntil } : undefined),
    },
    {
      id: `evt-${identityId}-${type.split(".")[1].toLowerCase()}`,
      tenant: `platform-${tenant}`,
      actor: { kind: "service", id: "yard/identity" },
      time,
      seq: type === "identity.Issued" ? 1 : 2,
      correlationId: `corr-${identityId}`,
      causationId: `cmd-${identityId}`,
    },
  );
  const validation = validateIdentityEvent(event);
  if (!validation.ok) {
    throw new Error(`invalid ${type} event: ${validation.errors.join("; ")}`);
  }
  return event;
}

function mtlsScope(spiffeId) {
  return {
    port: "mtls/x509-svid",
    resource: spiffeId,
    actions: ["authenticate"],
  };
}

function signCertificateBody(privateKey, body) {
  return createSign(SIGNING_ALGORITHM)
    .update(stableStringify(body))
    .end()
    .sign(privateKey, "base64url");
}

function verifyCertificateBody(publicKeyJwk, body, signature) {
  const verifier = createVerify(SIGNING_ALGORITHM).update(stableStringify(body)).end();
  return verifier.verify(createPublicKey({ key: publicKeyJwk, format: "jwk" }), signature, "base64url");
}

function firstSanUri(certificate) {
  const uris = certificate?.x509?.subjectAltName?.uris;
  if (!Array.isArray(uris) || uris.length !== 1 || !isJsonString(uris[0])) {
    throw new Error("certificate SAN must contain exactly one SPIFFE URI");
  }
  return uris[0];
}

function fingerprintJwk(jwk) {
  return `sha256:${createHash("sha256").update(stableStringify(jwk)).digest("hex")}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function coerceTimeMs(value, field) {
  if (isJsonNumber(value) && Number.isFinite(value)) {
    return value;
  }
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`${field} must be an epoch millisecond, Date, or ISO-8601 value`);
  }
  return ms;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function requireSegment(value, field) {
  const segment = requireString(value, field);
  if (!SEGMENT_PATTERN.test(segment)) {
    throw new Error(`${field} contains invalid characters`);
  }
  return segment;
}

function requireString(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function defaultIdFactory(prefix) {
  let next = 1;
  return () => `${prefix}-${next++}`;
}

function isPlainObject(value) {
  return (
    value !== null &&
    isJsonObject(value) &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
