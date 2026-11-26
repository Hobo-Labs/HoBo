import { createHash } from "node:crypto";

import {
  createDomainValidationGate,
  createLiveZoneSnapshot,
} from "../../domain-validation-gate-contract/src/domain-validation-gate.js";
import {
  createPreValidationDnsPort,
  routingPolicy,
} from "../../hobo-dns-port-contract/src/dns-port.js";
import { makeObligationEvent } from "../../obligation-engine-contract/src/obligation-engine.js";
import { isJsonString, isJsonObject } from "./json.js";


const DEFAULT_NOW = () => new Date("2026-06-27T16:00:00.000Z");
const DEFAULT_TTL_SECONDS = 60;
const DEFAULT_VALIDITY_DAYS = 90;

export async function requestAcmeDns01Certificate(input = {}) {
  const request = normalizeCertificateRequest(input);
  const order = request.identity.prepareDns01Order({
    domain: request.domain,
    camp: request.camp,
    camps: request.camps,
    subjectNames: request.subjectNames,
  });
  const dns = createPreValidationDnsPort({
    domain: request.domain,
    camp: request.camp,
    adapter: request.dnsAdapter,
  });
  const checks = request.checks ?? createAcmeValidationChecks({ acme: request.acme, order });
  const gate = request.gate ?? createDomainValidationGate({ checks });
  let shadowChange;

  const validation = await gate.validate({
    domain: request.domain,
    changeId: order.orderId,
    camp: request.camp,
    liveZone: createLiveZoneSnapshot(request.dnsAdapter, request.domain),
    stage: async () => {
      shadowChange = await dns.upsertRecord(order.challenge.record);
      return shadowChange;
    },
  });

  const events = [...validation.events];
  if (validation.status !== "validated") {
    publishEvents(request.eventSink, events);
    return deepFreeze({
      status: "failed",
      order,
      shadowChange,
      events,
      reason: validation.reason,
      failedCheck: validation.failedCheck,
    });
  }

  const certificate = request.identity.finalizeDns01Order(order);
  const issued = domainEvent("domain.CertIssued", {
    domain: request.domain,
    camp: request.camp,
    camps: request.camps,
    certRef: certificate.certRef,
    subjectNames: certificate.subjectNames,
    privateKeyRef: certificate.privateKeyRef,
    source: certificate.source,
    issuedAt: certificate.issuedAt,
    expiresAt: certificate.expiresAt,
    validationChangeId: order.orderId,
  });
  events.push(issued);
  publishEvents(request.eventSink, events);

  return deepFreeze({
    status: "issued",
    order,
    certificate,
    shadowChange,
    events,
  });
}

export async function rotateAcmeDns01Certificate(input = {}) {
  const domain = normalizeDomain(input.domain);
  const existingCertificate = normalizeCertificate(input.existingCertificate, domain);
  const camps = normalizeCamps(input);
  const now = input.now ?? DEFAULT_NOW;
  const renewBeforeDays = Number(input.renewBeforeDays ?? 30);
  if (!Number.isFinite(renewBeforeDays) || renewBeforeDays <= 0) {
    throw new Error("renewBeforeDays must be a positive number");
  }

  const millisecondsUntilExpiry = new Date(existingCertificate.expiresAt).getTime() - now().getTime();
  const renewalWindowMs = renewBeforeDays * 24 * 60 * 60 * 1000;
  if (millisecondsUntilExpiry > renewalWindowMs) {
    return deepFreeze({
      status: "not-due",
      existingCertificate,
      events: [],
    });
  }

  let issued;
  try {
    issued = await requestAcmeDns01Certificate({
      ...input,
      subjectNames: existingCertificate.subjectNames,
    });
  } catch (error) {
    return renewalEscalation({
      domain: normalizeDomain(input.domain),
      camp: camps[0],
      existingCertificate,
      reason: messageOf(error),
      now,
      eventSink: input.eventSink,
    });
  }
  if (issued.status !== "issued") {
    return renewalEscalation({
      domain: normalizeDomain(input.domain),
      camp: camps[0],
      existingCertificate,
      reason: issued.reason ?? "certificate renewal validation failed",
      now,
      priorEvents: issued.events,
      eventSink: input.eventSink,
    });
  }

  const rotated = domainEvent("domain.CertRotated", {
    domain: issued.order.domain,
    camp: issued.order.camp,
    camps: issued.order.camps,
    oldCertRef: existingCertificate.certRef,
    newCertRef: issued.certificate.certRef,
    privateKeyRef: issued.certificate.privateKeyRef,
    rotatedAt: issued.certificate.issuedAt,
    oldExpiresAt: existingCertificate.expiresAt,
    newExpiresAt: issued.certificate.expiresAt,
    source: issued.certificate.source,
  });
  input.eventSink?.(rotated);

  return deepFreeze({
    ...issued,
    status: "rotated",
    existingCertificate,
    events: [...issued.events, rotated],
  });
}

export function createFixtureIdentityCertificateAuthority(options = {}) {
  const issuer = requireString(options.issuer ?? "identity://yard", "issuer");
  const now = options.now ?? DEFAULT_NOW;
  const validityDays = Number(options.validityDays ?? DEFAULT_VALIDITY_DAYS);
  const failFinalize = options.failFinalize;
  const fixturePrivateKeyMaterial = "-----BEGIN PRIVATE KEY-----\nfixture-static-key-material\n-----END PRIVATE KEY-----";
  let next = 1;

  return Object.freeze({
    issuer,
    fixturePrivateKeyMaterial,

    prepareDns01Order(input = {}) {
      const domain = normalizeDomain(input.domain);
      const camps = normalizeCamps(input);
      const subjectNames = normalizeSubjectNames(input.subjectNames, domain);
      const orderId = `order-${slug(domain)}-${String(next++).padStart(4, "0")}`;
      const csrIntent = {
        domain,
        subjectNames,
        requestedBy: "identity",
        keyPolicy: "identity-held",
      };
      const keyThumbprint = digest(`${issuer}:${orderId}:${canonicalJson(csrIntent)}`).slice(0, 24);
      const token = digest(`dns01:${orderId}:${keyThumbprint}`).slice(0, 32);
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
      if (failFinalize) {
        throw new Error(String(failFinalize));
      }
      const issuedAt = now().toISOString();
      const expiresAt = new Date(now().getTime() + validityDays * 24 * 60 * 60 * 1000).toISOString();
      const certId = `${slug(normalized.domain)}-${normalized.orderId}`;

      return deepFreeze({
        certRef: `cert://identity/${certId}`,
        privateKeyRef: `keyref://identity/${certId}`,
        source: "identity-acme-dns01",
        issuer,
        subjectNames: normalized.subjectNames,
        issuedAt,
        expiresAt,
        publicCertPem: `-----BEGIN CERTIFICATE-----\n${digest(certId)}\n-----END CERTIFICATE-----`,
      });
    },
  });
}

export function createFixtureAcmeDns01Endpoint({ dnsAdapter }) {
  if (!dnsAdapter || !(dnsAdapter.inspectShadowZone instanceof Function)) {
    throw new Error("ACME DNS-01 endpoint requires a DNS adapter with inspectShadowZone(domain)");
  }

  return Object.freeze({
    async verifyChallenge(order) {
      const normalized = normalizeOrder(order);
      const expected = normalized.challenge;
      const shadowRecords = dnsAdapter.inspectShadowZone(normalized.domain);
      const record = shadowRecords.find(
        (candidate) => candidate.name === expected.challengeName && candidate.type === "TXT",
      );

      if (!record) {
        return fail(`missing DNS-01 challenge record ${expected.challengeName}`);
      }
      if (!record.targets.some((target) => target.value === expected.token)) {
        return fail(`DNS-01 challenge ${expected.challengeName} does not contain the order token`);
      }
      const missingCamp = expected.record.targets.find(
        (target) =>
          !record.targets.some(
            (candidate) => candidate.camp === target.camp && candidate.value === target.value,
          ),
      );
      if (missingCamp) {
        return fail(`DNS-01 challenge ${expected.challengeName} is missing camp ${missingCamp.camp}`);
      }
      if (!expected.keyThumbprint || expected.keyThumbprint.length < 12) {
        return fail("DNS-01 challenge must be key-thumbprint bound");
      }
      if (!expected.challengeName.startsWith(`_acme-challenge.${normalized.domain}`)) {
        return fail("DNS-01 challenge must be exact-domain bound");
      }
      if (expected.domain !== normalized.domain || expected.domain !== normalized.csrIntent.domain) {
        return fail("DNS-01 challenge must match CSR intent");
      }

      return pass({
        challengeName: expected.challengeName,
        keyThumbprint: expected.keyThumbprint,
        csrSubjectNames: normalized.csrIntent.subjectNames,
      });
    },
  });
}

export async function requestProviderManagedCertificate(input = {}) {
  const domain = normalizeDomain(input.domain);
  const camp = requireString(input.camp, "camp");
  const subjectNames = normalizeSubjectNames(input.subjectNames, domain);
  const adapter = requireProviderManagedAdapter(input.adapter);
  const certificate = await adapter.issueCertificate({ domain, camp, subjectNames });
  const normalizedCertificate = normalizeManagedCertificate(certificate, { domain, subjectNames });
  const issued = domainEvent("domain.CertIssued", {
    domain,
    camp,
    certRef: normalizedCertificate.certRef,
    subjectNames: normalizedCertificate.subjectNames,
    privateKeyRef: normalizedCertificate.privateKeyRef,
    source: normalizedCertificate.source,
    issuedAt: normalizedCertificate.issuedAt,
    expiresAt: normalizedCertificate.expiresAt,
    provider: normalizedCertificate.provider,
  });
  input.eventSink?.(issued);

  return deepFreeze({
    status: "issued",
    certificate: normalizedCertificate,
    events: [issued],
  });
}

export function createProviderManagedCertAdapter(options = {}) {
  const provider = requireString(options.provider, "provider");
  const now = options.now ?? DEFAULT_NOW;
  const validityDays = Number(options.validityDays ?? DEFAULT_VALIDITY_DAYS);
  const requests = [];
  let next = 1;

  return Object.freeze({
    provider,
    requests,
    async issueCertificate(input = {}) {
      const domain = normalizeDomain(input.domain);
      const subjectNames = normalizeSubjectNames(input.subjectNames, domain);
      const camp = requireString(input.camp, "camp");
      requests.push({ domain, camp, subjectNames });

      const issuedAt = now().toISOString();
      const expiresAt = new Date(now().getTime() + validityDays * 24 * 60 * 60 * 1000).toISOString();
      const id = `${slug(domain)}-${String(next++).padStart(4, "0")}`;

      return deepFreeze({
        certRef: `cert://provider/${provider}/${id}`,
        privateKeyRef: `provider-managed://${provider}/${id}`,
        source: "provider-managed",
        provider,
        subjectNames,
        issuedAt,
        expiresAt,
      });
    },
  });
}

export function assertNoStaticCertificateSecret(surfaces, secretValues) {
  const leaks = [];
  const secrets = [...new Set((secretValues ?? []).map(String).filter(Boolean))];

  for (const [surfaceName, surface] of Object.entries(surfaces ?? {})) {
    const serialized = isJsonString(surface) ? surface : JSON.stringify(surface);
    for (const secret of secrets) {
      if (serialized.includes(secret)) {
        leaks.push(`${surfaceName} contains static certificate secret`);
      }
    }
  }

  if (leaks.length > 0) {
    throw new Error(`certificate no-static-secret conformance failed: ${[...new Set(leaks)].join("; ")}`);
  }

  return deepFreeze({ ok: true });
}

function createAcmeValidationChecks({ acme, order }) {
  if (!acme || !(acme.verifyChallenge instanceof Function)) {
    throw new Error("ACME DNS-01 flow requires acme.verifyChallenge(order)");
  }
  return Object.freeze({
    "multi-vantage-resolve": () => pass({ source: "not-required-for-certificate-issue" }),
    "ttl-aware-propagation": () => pass({ ttlSeconds: DEFAULT_TTL_SECONDS, waitedSeconds: DEFAULT_TTL_SECONDS }),
    "acme-challenge": () => acme.verifyChallenge(order),
    "endpoint-health": () => pass({ source: "cert-issuance-only" }),
  });
}

function normalizeCertificateRequest(input) {
  const domain = normalizeDomain(input.domain);
  const camps = normalizeCamps(input);
  return {
    domain,
    camp: camps[0],
    camps,
    subjectNames: normalizeSubjectNames(input.subjectNames, domain),
    dnsAdapter: requireDnsAdapter(input.dnsAdapter),
    identity: requireIdentity(input.identity),
    acme: input.acme,
    checks: input.checks,
    gate: input.gate,
    eventSink: input.eventSink ?? (() => {}),
  };
}

function normalizeOrder(order) {
  if (!order || !isJsonObject(order)) {
    throw new Error("certificate order is required");
  }
  const camps = normalizeCamps(order);
  return {
    orderId: requireString(order.orderId, "orderId"),
    issuer: requireString(order.issuer, "issuer"),
    domain: normalizeDomain(order.domain),
    camp: camps[0],
    camps,
    subjectNames: normalizeSubjectNames(order.subjectNames, order.domain),
    csrIntent: order.csrIntent,
    challenge: order.challenge,
  };
}

function renewalEscalation({
  domain,
  camp,
  existingCertificate,
  reason,
  now,
  priorEvents = [],
  eventSink = () => {},
}) {
  const failedAt = now().toISOString();
  const dueBefore = new Date(new Date(existingCertificate.expiresAt).getTime() - 24 * 60 * 60 * 1000).toISOString();
  const events = [
    ...priorEvents,
    domainEvent("domain.CertRenewalFailed", {
      domain,
      camp,
      certRef: existingCertificate.certRef,
      reason,
      failedAt,
      expiresAt: existingCertificate.expiresAt,
    }),
    createCertificateRenewalObligation({
      domain,
      camp,
      existingCertificate,
      reason,
      failedAt,
      dueBefore,
    }),
  ];
  publishEvents(eventSink, events.slice(priorEvents.length));

  return deepFreeze({
    status: "escalated",
    existingCertificate,
    reason,
    events,
  });
}

function normalizeCertificate(certificate, domain) {
  if (!certificate || !isJsonObject(certificate)) {
    throw new Error("existingCertificate is required");
  }
  return {
    certRef: requireString(certificate.certRef, "certificate.certRef"),
    privateKeyRef: requireString(certificate.privateKeyRef, "certificate.privateKeyRef"),
    source: requireString(certificate.source, "certificate.source"),
    subjectNames: normalizeSubjectNames(certificate.subjectNames, domain),
    issuedAt: requireString(certificate.issuedAt, "certificate.issuedAt"),
    expiresAt: requireString(certificate.expiresAt, "certificate.expiresAt"),
  };
}

function createCertificateRenewalObligation({
  domain,
  camp,
  existingCertificate,
  reason,
  failedAt,
  dueBefore,
}) {
  const obligationId = `obligation-cert-renewal-${slug(domain)}-${digest(`${existingCertificate.certRef}:${reason}`).slice(0, 8)}`;
  const effectId = `effect-cert-renewal-${slug(domain)}-${digest(`${obligationId}:${dueBefore}`).slice(0, 8)}`;
  const obligation = {
    id: obligationId,
    kind: "certificate-renewal",
    deadline: dueBefore,
    effect: {
      id: effectId,
      kind: "human-renewal-escalation",
      contract: "hobo.effect.certificate-renewal-escalation/v1",
    },
    metadata: {
      domain,
      camp,
      certRef: existingCertificate.certRef,
      expiresAt: existingCertificate.expiresAt,
      reason,
    },
  };

  return makeObligationEvent({
    id: `${obligationId}:created`,
    type: "policy.ObligationCreated",
    obligationId,
    time: failedAt,
    data: {
      obligation,
      requestHash: `sha256:${digest(`cert-renewal-request:${domain}:${camp}:${existingCertificate.certRef}`)}`,
      decisionDigest: `sha256:${digest(`cert-renewal-decision:${reason}:${dueBefore}`)}`,
      decisionEffect: "require-certificate-renewal-escalation",
      policyIds: ["HOBO-144"],
    },
  });
}

function requireDnsAdapter(adapter) {
  if (
    !adapter ||
    !(adapter.upsertShadowRecord instanceof Function) ||
    !(adapter.inspectLiveZone instanceof Function) ||
    !(adapter.inspectShadowZone instanceof Function)
  ) {
    throw new Error("DNS-01 issuance requires a hobo:dns shadow adapter");
  }
  return adapter;
}

function requireIdentity(identity) {
  if (
    !identity ||
    !(identity.prepareDns01Order instanceof Function) ||
    !(identity.finalizeDns01Order instanceof Function)
  ) {
    throw new Error("certificate issuance requires Identity prepare/finalize methods");
  }
  return identity;
}

function requireProviderManagedAdapter(adapter) {
  if (!adapter || !(adapter.issueCertificate instanceof Function)) {
    throw new Error("provider-managed certificate request requires adapter.issueCertificate(input)");
  }
  return adapter;
}

function normalizeManagedCertificate(certificate, { domain, subjectNames }) {
  if (!certificate || !isJsonObject(certificate)) {
    throw new Error("provider-managed adapter did not return a certificate");
  }
  return {
    certRef: requireString(certificate.certRef, "certificate.certRef"),
    privateKeyRef: requireString(certificate.privateKeyRef, "certificate.privateKeyRef"),
    source: requireString(certificate.source, "certificate.source"),
    provider: requireString(certificate.provider, "certificate.provider"),
    subjectNames: normalizeSubjectNames(certificate.subjectNames ?? subjectNames, domain),
    issuedAt: requireString(certificate.issuedAt, "certificate.issuedAt"),
    expiresAt: requireString(certificate.expiresAt, "certificate.expiresAt"),
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
  if (value === domain || value.endsWith(`.${domain}`)) {
    return value;
  }
  if (value === `*.${domain}`) {
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

function publishEvents(eventSink, events) {
  for (const event of events) {
    eventSink(event);
  }
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

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
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
