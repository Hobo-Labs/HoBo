import { readFile } from "node:fs/promises";

import {
  CONNECTIVITY_PLAN_SCHEMA_VERSION,
  ConnectivityTier,
  decideConnectivityTier,
} from "../../../technical-proofs/connectivity-tier-ir-contract/src/connectivity-tier-ir.js";
import {
  enforceConnectivityCanDeploy,
} from "../../../technical-proofs/connectivity-policy-enforcement-contract/src/connectivity-policy-enforcement.js";
import {
  evaluateMtlsHandshake,
} from "../../../technical-proofs/mtls-data-path-contract/src/mtls-data-path.js";
import {
  projectYardManifest,
} from "../../../technical-proofs/yard-topology-manifest-contract/src/yard-topology-manifest.js";
import {
  planJunctionConnectivity,
  validateJunctionConnectivityPlan,
} from "../../../technical-proofs/junction-connectivity-plan-contract/src/junction-connectivity-plan.js";
import {
  createInMemoryDnsAdapter,
  createPreValidationDnsPort,
} from "../../../technical-proofs/hobo-dns-port-contract/src/dns-port.js";
import {
  createDomainValidationGate,
  createLiveZoneSnapshot,
  domainValidationChecks,
} from "../../../technical-proofs/domain-validation-gate-contract/src/domain-validation-gate.js";
import {
  requestAcmeDns01Certificate,
  createFixtureIdentityCertificateAuthority,
  createFixtureAcmeDns01Endpoint,
} from "../../../technical-proofs/acme-dns01-cert-issuance-contract/src/acme-dns01-cert-issuance.js";
import {
  createAirGapNetworkGuard,
  createInternalCaPrivateAcmeAuthority,
  createPrivateAcmeEndpoint,
  requestInternalCaPrivateAcmeCertificate,
} from "../../../technical-proofs/internal-ca-private-acme-contract/src/internal-ca-private-acme.js";
import {
  gatewayPort,
  service,
  trafficSplit,
} from "../../../technical-proofs/hobo-gateway-port/src/gateway-contract.js";
import {
  planGatewayRequest,
  realizeGateway,
} from "../../../technical-proofs/gateway-realization-contract/src/gateway-realization.js";
import {
  routeCrossCampTraffic,
} from "../../../technical-proofs/cross-camp-routing-policy-contract/src/cross-camp-routing-policy.js";
import {
  evaluateCostRoutingPlan,
} from "../../../technical-proofs/cost-routing-eligibility-contract/src/cost-routing-eligibility.js";
import {
  estimateConnectivityFeedback,
} from "../../../technical-proofs/connectivity-cost-feedback-contract/src/connectivity-cost-feedback.js";
import {
  federateJunctionDomain,
  validateJunctionDomainPlan,
} from "../../../technical-proofs/junction-federated-domain-contract/src/junction-federated-domain.js";
import {
  evaluateSplitHorizonResolution,
  routeWithPartitionSafety,
} from "../../../technical-proofs/split-horizon-partition-connectivity-contract/src/split-horizon-partition-connectivity.js";
import {
  validateAndPinDnsEvidence,
} from "../../../technical-proofs/dns-validation-rebinding-guard-contract/src/dns-validation-rebinding-guard.js";
import {
  evaluateTopologyOverrideCanDeploy,
} from "../../../technical-proofs/topology-override-conflict-contract/src/topology-override-conflict.js";
import {
  createInternalServiceDirectory,
} from "../../../technical-proofs/internal-service-discovery-contract/src/internal-service-discovery.js";
import {
  attachRelay,
  dispatchRelayWork,
  registerRelay,
  routeRelayTarget,
} from "../../../technical-proofs/hobo-relay-contract/src/hobo-relay.js";
import {
  createTenantRoutingTable,
  routeTenantRequest,
} from "../../../exp-proofs/api/per-app-tenant-routing-contract/src/per-app-tenant-routing.js";

const FIXTURE_URL = new URL("../simulation/fixtures/networking-reference-fixture.json", import.meta.url);

export const CONTRACTS_COVERED = Object.freeze([
  "ConnectivityTierSelector",
  "ConnectivityPolicyGate",
  "IdentityMtlsDataPath",
  "YardTopologyManifest",
  "JunctionConnectivityPlanner",
  "DnsShadowPort",
  "DomainValidationGate",
  "CertificateAuthority",
  "GatewayTrafficRouter",
  "CostRoutingLedger",
  "HoBoRelayPrivateExecutor",
  "TenantRoutingClaims",
]);

export async function runNetworkingConnectivityDnsRelaySimulation(options = {}) {
  const fixture = options.fixture ?? await loadFixture();
  const crossCloudBind = runCrossCloudBindReference(fixture);
  const domainPromotion = await runDomainPromotionReference(fixture);
  const relay = runRelayReference(fixture);
  const tenantIngress = runTenantIngressReference(fixture);
  const negative = runNegativeReference({ fixture, crossCloudBind, domainPromotion });

  return {
    epic: {
      id: "70e2d1f1-c7fc-4dd0-bff5-87c0b7b83dda",
      title: "Networking, Connectivity, DNS & Relay",
      slug: "networking-connectivity-dns-relay",
    },
    crossCloudBind,
    domainPromotion,
    relay,
    tenantIngress,
    negative,
    contracts: {
      covered: [...CONTRACTS_COVERED],
      missing: [],
    },
  };
}

async function loadFixture() {
  return JSON.parse(await readFile(FIXTURE_URL, "utf8"));
}

function runCrossCloudBindReference(fixture) {
  const tierDecision = decideConnectivityTier(fixture.crossCloudBind.edge);
  if (!tierDecision.ok) {
    throw new Error(tierDecision.reason);
  }
  const tierPlan = tierDecision.plan;
  const policyGate = normalizePolicyGate(
    enforceConnectivityCanDeploy({
      plan: tierPlan,
      environment: "prod",
      policyDecision: allowPolicyDecision({
        constraints: {
          maxTier: ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT,
          requireMtls: true,
          residencyTags: ["us-only"],
        },
      }),
    }),
  );
  const mtls = evaluateMtlsHandshake(fixture.crossCloudBind.mtlsHandshake);
  const topology = runYardTopologyReference(fixture);
  const discovery = runInternalDiscoveryReference(fixture);
  const costFeedback = estimateConnectivityFeedback({
    plan: tierPlan,
    costCatalog: fixture.crossCloudBind.costCatalog,
    latencyCatalog: fixture.crossCloudBind.latencyCatalog,
  });

  return {
    outcome: policyGate.effect === "allow" && mtls.ok && topology.junction.validation.ok ? "deployable" : "blocked",
    tierPlan,
    policyGate,
    mtls,
    topology: topology.manifests,
    junction: topology.junction,
    discovery,
    costFeedback,
  };
}

function runYardTopologyReference(fixture) {
  const members = fixture.crossCloudBind.yards.map((yard) => ({
    manifest: projectYardManifest(yard),
  }));
  const planned = planJunctionConnectivity({
    junctionId: "junction-networking-prod",
    members,
    tierCapabilities: [
      {
        sourceYardId: "yard-aws-us",
        targetYardId: "yard-azure-eu",
        supportedTiers: [ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT],
      },
    ],
  });
  if (!planned.ok) {
    throw new Error(planned.reason);
  }

  return {
    manifests: members.map((member) => member.manifest),
    junction: {
      plan: planned.plan,
      validation: validateJunctionConnectivityPlan(planned.plan),
      deliveryYards: Object.keys(planned.plan.deliveriesByYard),
    },
  };
}

function runInternalDiscoveryReference(fixture) {
  const directory = createInternalServiceDirectory(fixture.crossCloudBind.discovery.directory);
  for (const resource of fixture.crossCloudBind.discovery.resources) {
    directory.registerResource(resource);
  }
  directory.bind(fixture.crossCloudBind.discovery.binding);
  return directory.discoverPeer(fixture.crossCloudBind.discovery.request);
}

async function runDomainPromotionReference(fixture) {
  const adapter = createInMemoryDnsAdapter({ id: "networking-reference-dns" });
  const dns = createPreValidationDnsPort({
    domain: fixture.domainPromotion.domain,
    camp: fixture.domainPromotion.camp,
    adapter,
  });
  const validationGate = createDomainValidationGate({
    checks: domainValidationChecks(fixture.domainPromotion.validationFixtures),
  });
  const validation = await validationGate.validate({
    domain: fixture.domainPromotion.domain,
    changeId: "domain-change-prod-api",
    camp: fixture.domainPromotion.camp,
    liveZone: createLiveZoneSnapshot(adapter, fixture.domainPromotion.domain),
    stage: () => dns.upsertRecord(fixture.domainPromotion.record),
  });
  const identity = createFixtureIdentityCertificateAuthority();
  const acme = await requestAcmeDns01Certificate({
    domain: fixture.domainPromotion.domain,
    camp: fixture.domainPromotion.camp,
    camps: fixture.domainPromotion.camps,
    dnsAdapter: adapter,
    identity,
    acme: createFixtureAcmeDns01Endpoint({ dnsAdapter: adapter }),
    subjectNames: [fixture.domainPromotion.domain],
  });
  const internalCa = await runInternalCaReference(fixture);
  const gateway = runGatewayReference(fixture, acme);
  const routing = routeCrossCampTraffic(fixture.domainPromotion.routingRequest);
  const costRouting = evaluateCostRoutingPlan(fixture.domainPromotion.costRouting);
  const junctionDomain = await federateJunctionDomain(junctionDomainInput(fixture));
  const negativeRebinding = validateAndPinDnsEvidence(
    fixture.domainPromotion.rebinding.change,
    fixture.domainPromotion.rebinding.badEvidence,
    { nowMs: 1_000 },
  );
  const negativeSplitHorizon = evaluateSplitHorizonResolution(fixture.domainPromotion.splitHorizon);

  return {
    validation,
    acme: pick(acme, ["status", "certificate"]),
    internalCa,
    gateway,
    routing,
    costRouting,
    junctionDomain: {
      status: junctionDomain.status,
      validation: junctionDomain.status === "ready" ? validateJunctionDomainPlan(junctionDomain.plan) : null,
      deliveryYards: junctionDomain.status === "ready" ? Object.keys(junctionDomain.plan.deliveriesByYard) : [],
    },
    negativeRebinding,
    negativeSplitHorizon,
    liveZoneWrites: adapter.inspectLiveZone(fixture.domainPromotion.domain).length,
  };
}

async function runInternalCaReference(fixture) {
  const profile = {
    yard: "yard-sovereign",
    camp: "camp-sovereign",
    boundary: "sovereign-boundary",
    egress: "none",
  };
  const adapter = createInMemoryDnsAdapter({ id: "airgap-dns" });
  const network = createAirGapNetworkGuard({ boundary: profile.boundary });
  const authority = createInternalCaPrivateAcmeAuthority({ boundary: profile.boundary });
  const endpoint = createPrivateAcmeEndpoint({
    boundary: profile.boundary,
    dnsAdapter: adapter,
    network,
  });
  const result = await requestInternalCaPrivateAcmeCertificate({
    profile,
    domain: fixture.domainPromotion.domain,
    dnsAdapter: adapter,
    authority,
    acme: endpoint,
    subjectNames: [fixture.domainPromotion.domain],
  });

  return {
    status: result.status,
    certificate: result.certificate,
    network: network.snapshot(),
  };
}

function runGatewayReference(fixture, acme) {
  const gateway = gatewayPort("networking-edge")
    .terminateTls({ minVersion: "TLS1.2", certificateRef: acme.certificate.certRef })
    .route(
      fixture.domainPromotion.domain,
      "/api",
      service("orders-api"),
      trafficSplit([
        { target: "orders-v1", weight: 90 },
        { target: "orders-v2", weight: 10 },
      ]),
    )
    .build();
  const deployment = realizeGateway(gateway, {
    provider: "mock-edge",
    health: { "orders-v1": "healthy", "orders-v2": "healthy" },
  });
  const request = planGatewayRequest(deployment, {
    scheme: "https",
    host: fixture.domainPromotion.domain,
    path: "/api/orders",
    method: "GET",
    roll: 9,
  });
  return {
    status: request.served ? "ready" : "blocked",
    deployment,
    request,
  };
}

function junctionDomainInput(fixture) {
  const adapter = createInMemoryDnsAdapter({ id: "junction-domain" });
  return {
    ...fixture.domainPromotion.junctionDomain,
    yards: fixture.domainPromotion.junctionDomain.yards.map((yard) => ({
      ...yard,
      dnsAdapter: adapter,
      validationFixtures: fixture.domainPromotion.validationFixtures,
    })),
  };
}

function runRelayReference(fixture) {
  const registration = registerRelay(fixture.relay.spec, allowPolicyDecision({ action: "hobo:relay:register" }));
  const attached = attachRelay(registration.relay, allowPolicyDecision({ action: "hobo:relay:attach" }));
  const session = attached.session;
  const target = routeRelayTarget(session, "private-db");
  const execution = dispatchRelayWork(session, fixture.relay.work);
  const deniedAttempts = [
    ["relay.target.not-allowed", routeRelayTarget(session, "metadata-service")],
    ["relay.forward-proxy.denied", dispatchRelayWork(session, fixture.relay.forwardProxyWork)],
    ["relay.credential-egress.denied", dispatchRelayWork(session, fixture.relay.credentialEgressWork)],
  ].map(([epicCode, attempt]) => ({
    ok: attempt.ok,
    code: epicCode,
    providerCode: attempt.code,
    reason: attempt.reason,
  }));

  return {
    status: attached.ok ? "attached" : "blocked",
    target,
    execution: {
      status: execution.ok ? "completed" : "blocked",
      ok: execution.ok,
      yardFrames: execution.yardFrames,
    },
    deniedAttempts,
    network: {
      outboundOnly: session.transport.direction === "relay-to-yard" && session.hasInboundListener === false,
      port: session.transport.port,
    },
  };
}

function runTenantIngressReference(fixture) {
  const routingTable = createTenantRoutingTable(fixture.tenantIngress.routingTable);
  const resolved = routeTenantRequest(routingTable, fixture.tenantIngress.request, (ctx) => ({
    tenantId: ctx.tenant.id,
    camp: ctx.placement.camp,
  }));
  const mismatch = routeTenantRequest(routingTable, fixture.tenantIngress.mismatchRequest);

  return {
    resolved: {
      ok: resolved.effect === "allow",
      resolvedBy: resolved.resolvedBy,
      ctx: { tenant: resolved.ctx.tenant.id },
    },
    placement: {
      kind: resolved.ctx.placement.mode,
      camp: resolved.ctx.placement.camp,
      region: resolved.ctx.placement.region,
    },
    mismatch: {
      ok: mismatch.effect === "allow",
      code: mismatch.code ?? "tenant-routing.tenant-mismatch",
      reason: mismatch.reason,
    },
  };
}

function runNegativeReference({ fixture, crossCloudBind, domainPromotion }) {
  const publicPlan = {
    schemaVersion: CONNECTIVITY_PLAN_SCHEMA_VERSION,
    edgeId: "orders.api->public.partner",
    source: { resourceId: "orders.api", provider: "aws", region: "us-east-1", yardId: "yard-aws-us" },
    target: { resourceId: "partner.api", provider: "internet", region: "global", yardId: "public-internet" },
    tier: ConnectivityTier.PUBLIC_MTLS,
    endpoints: {
      sourceLogicalName: "ctx.bindings.partner",
      targetLogicalName: "partner.api",
    },
    identity: {
      source: "spiffe://tenant-alpha/orders/api",
      target: "spiffe://tenant-alpha/orders/partner",
    },
    parameters: { publicEndpointRef: "https://partner.example", mtlsRequired: false },
    policy: { maxTier: ConnectivityTier.OVERLAY_MESH, allowPublicMtls: false },
    override: { requestedTier: ConnectivityTier.PUBLIC_MTLS, reason: "public shortcut" },
  };
  const policyWidening = normalizePolicyGate(enforceConnectivityCanDeploy({
    plan: {
      ...crossCloudBind.tierPlan,
      override: { source: ".with()", requestedTierName: "internet-mtls" },
    },
    environment: "prod",
    policyDecision: allowPolicyDecision({
      constraints: { maxTier: ConnectivityTier.OVERLAY_MESH },
    }),
  }));
  const publicTierRequiresMtls = normalizePolicyGate(enforceConnectivityCanDeploy({
    plan: publicPlan,
    environment: "prod",
    policyDecision: allowPolicyDecision({
      constraints: {
        maxTier: ConnectivityTier.OVERLAY_MESH,
        forbiddenTiers: [ConnectivityTier.PUBLIC_MTLS],
      },
    }),
  }));
  const overrideConflict = evaluateTopologyOverrideCanDeploy({
    inferredPlan: crossCloudBind.junction.plan,
    overrides: fixture.negative.topologyOverrides,
    policyDecision: allowPolicyDecision(),
    topologySeq: 42,
  });
  const partitionSafety = routeWithPartitionSafety(fixture.negative.partitionRouting);

  return {
    policyWidening,
    publicTierRequiresMtls,
    overrideConflict,
    partitionSafety,
    validationThreatsCovered: [
      domainPromotion.negativeRebinding.status,
      domainPromotion.negativeSplitHorizon.promotion,
    ],
  };
}

function normalizePolicyGate(result) {
  return {
    ok: result.ok,
    effect: result.ok ? "allow" : "deny",
    code: result.code ?? "connectivity.policy.allowed",
    reason: result.reason ?? result.enforcementEvent?.data?.reason ?? "policy matched",
    enforcementEvent: result.enforcementEvent,
  };
}

function allowPolicyDecision(overrides = {}) {
  return {
    decisionId: overrides.decisionId ?? "policy-networking-reference",
    phase: "can-deploy",
    effect: "allow",
    reason: "policy matched",
    evidence: { policyIds: ["pack-networking-prod"] },
    obligations: [],
    ...overrides,
  };
}

function pick(value, fields) {
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}
