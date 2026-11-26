import { createHash } from "node:crypto";

import {
  requestAcmeDns01Certificate,
  rotateAcmeDns01Certificate,
} from "../../acme-dns01-cert-issuance-contract/src/acme-dns01-cert-issuance.js";
import { routingPolicy } from "../../hobo-dns-port-contract/src/dns-port.js";
import { isJsonString, isJsonObject } from "./json.js";


const DEFAULT_NOW = () => new Date("2026-06-28T06:00:00.000Z");
const DEFAULT_TTL_SECONDS = 60;
const DEFAULT_VALIDITY_DAYS = 90;

export function createAirGapNetworkGuard({ boundary }) {
  const normalizedBoundary = requireString(boundary, "boundary");
  const internalCalls = [];
  const egressAttempts = [];

  return Object.freeze({
    boundary: normalizedBoundary,

    recordInternal(endpoint) {
      internalCalls.push(requireString(endpoint, "internal endpoint"));
    },

    recordEgress(endpoint) {
      egressAttempts.push(requireString(endpoint, "egress endpoint"));
      throw new Error(`air-gapped boundary ${normalizedBoundary} forbids public egress`);
    },

    snapshot() {
      return deepFreeze({
        boundary: normalizedBoundary,
        internalCalls: [...internalCalls],
        egressAttempts: [...egressAttempts],
      });
    },
  });
}

export function createInternalCaPrivateAcmeAuthority(options = {}) {
  const boundary = requireString(options.boundary, "boundary");
  const caName = requireString(options.caName ?? "sovereign-ca", "caName");
  const caKeyRef = requireInBoundaryCaKeyRef(
    options.caKeyRef ?? `keyref://kms/${boundary}/ca/${caName}`,
    boundary,
  );
  const issuer = `private-acme://${boundary}/${caName}`;
  const now = options.now ?? DEFAULT_NOW;
  const validityDays = Number(options.validityDays ?? DEFAULT_VALIDITY_DAYS);
  const fixtureCaKeyMaterial =
    options.fixtureCaKeyMaterial ?? "-----BEGIN PRIVATE KEY-----\nfixture-airgap-ca-key\n-----END PRIVATE KEY-----";
  let next = 1;

  if (!Number.isFinite(validityDays) || validityDays <= 0) {
    throw new Error("validityDays must be a positive number");
  }

  return Object.freeze({
    kind: "internal-ca-private-acme",
    boundary,
    caName,
    caKeyRef,
    fixtureCaKeyMaterial,
    issuer,

    prepareDns01Order(input = {}) {
      const domain = normalizeDomain(input.domain);
      const camps = normalizeCamps(input);
      const subjectNames = normalizeSubjectNames(input.subjectNames, domain);
      const orderId = `private-acme-${slug(domain)}-${String(next++).padStart(4, "0")}`;
      const csrIntent = deepFreeze({
        domain,
        subjectNames,
        requestedBy: "airgap-yard",
        keyPolicy: "in-boundary-kms-held",
        caKeyRef,
        boundary,
      });
      const keyThumbprint = digest(`${issuer}:${orderId}:${canonicalJson(csrIntent)}`).slice(0, 24);
      const token = digest(`private-acme-dns01:${orderId}:${keyThumbprint}`).slice(0, 32);
      const challengeName = `_acme-challenge.${domain}`;

      return deepFreeze({
        orderId,
        issuer,
        domain,
        camp: camps[0],
        camps,
        subjectNames,
        csrIntent,
        challenge: {
          kind: "dns-01",
          domain,
          challengeName,
          keyThumbprint,
          token,
          record: {
            name: challengeName,
            type: "TXT",
            ttl: DEFAULT_TTL_SECONDS,
            targets: camps.map((camp) => ({ camp, value: token })),
            policy: routingPolicy(
              "failover",
              camps.map((camp, index) => ({ camp, priority: index + 1 })),
            ),
            campOverrides: camps.map((camp) => ({
              camp,
              targets: [{ camp, value: token }],
            })),
          },
        },
      });
    },

    finalizeDns01Order(order) {
      const normalized = normalizeOrder(order);
      const issuedAt = now().toISOString();
      const expiresAt = new Date(now().getTime() + validityDays * 24 * 60 * 60 * 1000).toISOString();
      const certId = `${slug(normalized.domain)}-${normalized.orderId}`;

      return deepFreeze({
        certRef: `cert://internal-ca/${boundary}/${certId}`,
        privateKeyRef: `keyref://kms/${boundary}/tls/${certId}`,
        caKeyRef,
        source: "internal-ca-private-acme",
        issuer,
        boundary,
        subjectNames: normalized.subjectNames,
        issuedAt,
        expiresAt,
        publicCertPem: `-----BEGIN CERTIFICATE-----\n${digest(`${certId}:${caKeyRef}`)}\n-----END CERTIFICATE-----`,
      });
    },
  });
}

export function createPrivateAcmeEndpoint({ boundary, dnsAdapter, network, caName = "sovereign-ca" } = {}) {
  const normalizedBoundary = requireString(boundary, "boundary");
  const normalizedCaName = requireString(caName, "caName");
  const adapter = requireDnsAdapter(dnsAdapter);

  if (!network || !(network.recordInternal instanceof Function)) {
    throw new Error("private ACME endpoint requires an air-gap network guard");
  }

  return Object.freeze({
    kind: "private-acme",
    boundary: normalizedBoundary,
    caName: normalizedCaName,

    async verifyChallenge(order) {
      const normalized = normalizeOrder(order);
      const expected = normalized.challenge;
      network.recordInternal(`private-acme://${normalizedBoundary}/${normalizedCaName}`);

      if (normalized.csrIntent.boundary !== normalizedBoundary) {
        return fail("private ACME request crossed Yard boundary");
      }
      if (normalized.issuer !== `private-acme://${normalizedBoundary}/${normalizedCaName}`) {
        return fail("private ACME order issuer does not match endpoint");
      }
      if (!normalized.csrIntent.caKeyRef?.startsWith(`keyref://kms/${normalizedBoundary}/`)) {
        return fail("private ACME order requires an in-boundary CA key reference");
      }

      const shadowRecords = adapter.inspectShadowZone(normalized.domain);
      const record = shadowRecords.find(
        (candidate) => candidate.name === expected.challengeName && candidate.type === "TXT",
      );

      if (!record) {
        return fail(`missing private ACME DNS-01 challenge record ${expected.challengeName}`);
      }
      if (!record.targets.some((target) => target.value === expected.token)) {
        return fail(`private ACME DNS-01 challenge ${expected.challengeName} does not contain the order token`);
      }
      const missingCamp = expected.record.targets.find(
        (target) =>
          !record.targets.some(
            (candidate) => candidate.camp === target.camp && candidate.value === target.value,
          ),
      );
      if (missingCamp) {
        return fail(`private ACME DNS-01 challenge ${expected.challengeName} is missing camp ${missingCamp.camp}`);
      }
      if (!expected.keyThumbprint || expected.keyThumbprint.length < 12) {
        return fail("private ACME DNS-01 challenge must be key-thumbprint bound");
      }
      if (!expected.challengeName.startsWith(`_acme-challenge.${normalized.domain}`)) {
        return fail("private ACME DNS-01 challenge must be exact-domain bound");
      }
      if (expected.domain !== normalized.domain || expected.domain !== normalized.csrIntent.domain) {
        return fail("private ACME DNS-01 challenge must match CSR intent");
      }

      return pass({
        source: "private-acme",
        boundary: normalizedBoundary,
        caName: normalizedCaName,
        challengeName: expected.challengeName,
        keyThumbprint: expected.keyThumbprint,
        csrSubjectNames: normalized.csrIntent.subjectNames,
      });
    },
  });
}

export function createPublicAcmeEndpoint({ network } = {}) {
  return Object.freeze({
    kind: "public-acme",

    async verifyChallenge() {
      network?.recordEgress("https://acme-v02.api.letsencrypt.org/directory");
      return fail("public ACME is unavailable inside an air-gapped Yard");
    },
  });
}

export async function requestInternalCaPrivateAcmeCertificate(input = {}) {
  const request = normalizeAirGapRequest(input);
  const refusal = privateAcmeRefusal(request);
  if (refusal) {
    return refusal;
  }

  return requestAcmeDns01Certificate({
    ...input,
    camp: request.profile.camp,
    camps: [request.profile.camp],
    domain: request.domain,
    subjectNames: request.subjectNames,
    identity: request.authority,
    acme: request.acme,
    dnsAdapter: request.dnsAdapter,
  });
}

export async function rotateInternalCaPrivateAcmeCertificate(input = {}) {
  const request = normalizeAirGapRequest(input);
  const refusal = privateAcmeRefusal(request);
  if (refusal) {
    return refusal;
  }

  return rotateAcmeDns01Certificate({
    ...input,
    camp: request.profile.camp,
    camps: [request.profile.camp],
    domain: request.domain,
    subjectNames: request.subjectNames,
    identity: request.authority,
    acme: request.acme,
    dnsAdapter: request.dnsAdapter,
  });
}

function normalizeAirGapRequest(input) {
  const profile = normalizeProfile(input.profile);
  const domain = normalizeDomain(input.domain);
  const authority = requireAuthority(input.authority, profile.boundary);
  const dnsAdapter = requireDnsAdapter(input.dnsAdapter);
  return {
    profile,
    domain,
    subjectNames: normalizeSubjectNames(input.subjectNames, domain),
    authority,
    acme: input.acme,
    dnsAdapter,
    eventSink: input.eventSink ?? (() => {}),
  };
}

function privateAcmeRefusal(request) {
  if (!request.acme || request.acme.kind !== "private-acme") {
    return refusedCertificateResult({
      domain: request.domain,
      camp: request.profile.camp,
      reason: "public ACME is forbidden for an air-gapped Camp; configure private ACME in the Yard boundary",
      eventSink: request.eventSink,
    });
  }
  if (request.acme.boundary !== request.profile.boundary) {
    return refusedCertificateResult({
      domain: request.domain,
      camp: request.profile.camp,
      reason: `private ACME boundary ${request.acme.boundary} does not match ${request.profile.boundary}`,
      eventSink: request.eventSink,
    });
  }
  return undefined;
}

function refusedCertificateResult({ domain, camp, reason, eventSink }) {
  const event = domainEvent("domain.CertIssuanceRefused", {
    domain,
    camp,
    reason,
    source: "internal-ca-private-acme",
  });
  eventSink?.(event);
  return deepFreeze({
    status: "refused",
    reason,
    events: [event],
  });
}

function normalizeProfile(profile) {
  if (!profile || !isJsonObject(profile)) {
    throw new Error("air-gapped Yard profile is required");
  }
  const egress = requireString(profile.egress, "profile.egress");
  if (egress !== "none") {
    throw new Error("internal CA/private ACME profile requires profile.egress to be none");
  }
  return deepFreeze({
    yard: requireString(profile.yard, "profile.yard"),
    camp: requireString(profile.camp, "profile.camp"),
    boundary: requireString(profile.boundary, "profile.boundary"),
    egress,
  });
}

function requireAuthority(authority, boundary) {
  if (
    !authority ||
    authority.kind !== "internal-ca-private-acme" ||
    !(authority.prepareDns01Order instanceof Function) ||
    !(authority.finalizeDns01Order instanceof Function)
  ) {
    throw new Error("internal CA/private ACME issuance requires an internal authority adapter");
  }
  if (authority.boundary !== boundary) {
    throw new Error(`authority boundary ${authority.boundary} does not match profile boundary ${boundary}`);
  }
  requireInBoundaryCaKeyRef(authority.caKeyRef, boundary);
  return authority;
}

function requireInBoundaryCaKeyRef(caKeyRef, boundary) {
  const keyRef = requireString(caKeyRef, "caKeyRef");
  if (!keyRef.startsWith(`keyref://kms/${boundary}/`)) {
    throw new Error(`CA key must use an in-boundary KMS keyref for ${boundary}`);
  }
  return keyRef;
}

function requireDnsAdapter(adapter) {
  if (
    !adapter ||
    !(adapter.upsertShadowRecord instanceof Function) ||
    !(adapter.inspectLiveZone instanceof Function) ||
    !(adapter.inspectShadowZone instanceof Function)
  ) {
    throw new Error("private ACME issuance requires a hobo:dns shadow adapter");
  }
  return adapter;
}

function normalizeOrder(order) {
  if (!order || !isJsonObject(order)) {
    throw new Error("private ACME order is required");
  }
  const camps = normalizeCamps(order);
  return {
    orderId: requireString(order.orderId, "orderId"),
    issuer: requireString(order.issuer, "issuer"),
    domain: normalizeDomain(order.domain),
    camp: camps[0],
    camps,
    subjectNames: normalizeSubjectNames(order.subjectNames, order.domain),
    csrIntent: order.csrIntent ?? {},
    challenge: order.challenge ?? {},
  };
}

function normalizeCamps(input) {
  const source = input.camps ?? [input.camp];
  if (!Array.isArray(source) || source.length === 0) {
    throw new Error("camps requires at least one camp");
  }

  const camps = [];
  for (const entry of source) {
    const camp = requireString(entry, "camp");
    if (!camps.includes(camp)) {
      camps.push(camp);
    }
  }

  if (input.camp !== undefined) {
    const primary = requireString(input.camp, "camp");
    if (!camps.includes(primary)) {
      throw new Error("camp must be included in camps");
    }
    return [primary, ...camps.filter((camp) => camp !== primary)];
  }

  return camps;
}

function normalizeSubjectNames(subjectNames, domain) {
  const values = subjectNames?.length ? subjectNames : [domain];
  const normalized = [...new Set(values.map((name) => normalizeSubjectName(name, domain)))].sort();
  if (!normalized.includes(domain)) {
    normalized.push(domain);
    normalized.sort();
  }
  return normalized;
}

function normalizeSubjectName(name, domain) {
  const value = requireString(name, "subject name").toLowerCase();
  if (value === domain || value === `*.${domain}` || value.endsWith(`.${domain}`)) {
    return value;
  }
  throw new Error(`subject name ${name} must be ${domain} or inside it`);
}

function normalizeDomain(domain) {
  const value = requireString(domain, "domain").toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value) || !value.includes(".")) {
    throw new Error(`invalid domain: ${domain}`);
  }
  return value;
}

function domainEvent(type, data) {
  return deepFreeze({ type, data });
}

function pass(evidence) {
  return deepFreeze({ ok: true, evidence });
}

function fail(reason) {
  return deepFreeze({ ok: false, reason });
}

function requireString(value, field) {
  if (!isJsonString(value) || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function slug(value) {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
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
