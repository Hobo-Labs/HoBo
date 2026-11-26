import { isJsonObject } from "./json.js";
import {
  createPortableMultiCloudShopRun,
  verifyMultiCloudShopGate,
  MULTI_CLOUD_SHOP_FIXTURE,
} from "../../multi-cloud-shop-provider-e2e-contract/src/multi-cloud-shop-gate.js";
import {
  createX509SvidAuthority,
  establishMutualTls,
} from "../../x509-svid-mtls-contract/src/x509-svid-mtls.js";
import {
  decideResourceDefinition,
  matchingDecisionToEvent,
} from "../../matching-engine-skeleton-contract/src/matching-engine.js";
import { createResourceCatalog } from "../../resource-definition-driver-contract/src/resource-definition-driver-contract.js";

export const S4_STAGE_GATE_SCHEMA = "hobo.s4StageGateMultiCloud/v1";
export const S4_STAGE_GATE_FIXTURE = MULTI_CLOUD_SHOP_FIXTURE;
export const S4_ACCEPTANCE_RECORD = "docs/design/proofs/s4-01-stage-gate-acceptance";

const BASE_TIME = Date.parse("2026-07-02T00:00:00.000Z");
const TENANT = "acme";
const BINDLE = "multi-cloud-shop";

export class S4StageGateError extends Error {
  constructor(report) {
    super(report.failures.map((failure) => `${failure.code}: ${failure.message}`).join("; "));
    this.name = "S4StageGateError";
    this.report = report;
  }
}

export function createS4StageGateEvidence(overrides = {}) {
  const portability = createPortableMultiCloudShopRun(overrides.portability );
  const crossCloudMtls = createCrossCloudMtlsEvidence(overrides.crossCloudMtls );
  const j3ProviderSwitch = createJ3ProviderSwitchEvidence(portability, overrides.j3ProviderSwitch );
  const matchingResolution = createMatchingResolutionEvidence(overrides.matchingResolution );

  return deepFreeze({
    schema: S4_STAGE_GATE_SCHEMA,
    fixture: S4_STAGE_GATE_FIXTURE,
    acceptanceRecord: S4_ACCEPTANCE_RECORD,
    ciLane: {
      name: "s4-stage-gate-drill",
      tag: "camp",
      costAware: true,
      credentialed: true,
      gatedBy: [
        { kind: "pull-request-label", label: "hobo/s4-drill" },
        { kind: "schedule", cron: "23 4 * * 1" },
        { kind: "manual" },
      ],
    },
    portability,
    crossCloudMtls,
    j3ProviderSwitch,
    matchingResolution,
    ...overrides.root,
  });
}

export function verifyS4StageGate(evidence) {
  const failures = [];

  if (evidence?.schema !== S4_STAGE_GATE_SCHEMA) {
    failures.push({
      code: "schema.unsupported",
      message: `expected schema ${S4_STAGE_GATE_SCHEMA}`,
    });
  }
  if (evidence?.fixture !== S4_STAGE_GATE_FIXTURE) {
    failures.push({
      code: "fixture.missing",
      message: `expected fixture ${S4_STAGE_GATE_FIXTURE}`,
    });
  }

  validateCiLane(evidence?.ciLane, failures);

  const portabilityReport = verifyMultiCloudShopGate(evidence?.portability );
  if (!portabilityReport.ok) {
    failures.push(...portabilityReport.failures.map((failure) => ({
      ...failure,
      code: `portability.${failure.code}`,
    })));
  }

  validateCrossCloudMtls(evidence?.crossCloudMtls, failures);
  validateJ3ProviderSwitch(evidence?.j3ProviderSwitch, evidence?.portability, failures);
  validateMatchingResolution(evidence?.matchingResolution, failures);

  const ok = failures.length === 0;
  return deepFreeze({
    ok,
    schema: S4_STAGE_GATE_SCHEMA,
    fixture: evidence?.fixture,
    acceptanceRecord: evidence?.acceptanceRecord,
    targetProviders: portabilityReport.targetProviders,
    failures,
    events: ok
      ? [
          {
            type: "s4StageGate.DrillPassed",
            fixture: evidence.fixture,
            acceptanceRecord: evidence.acceptanceRecord,
            targetProviders: portabilityReport.targetProviders,
          },
        ]
      : [
          {
            type: "deployment.PlanRejected",
            reason: "s4-stage-gate.drill-failed",
            failures,
          },
        ],
  });
}

export function assertS4StageGate(evidence) {
  const report = verifyS4StageGate(evidence);
  if (!report.ok) {
    throw new S4StageGateError(report);
  }
  return report;
}

export function runS4StageGateDrill({ phase = "deploy-and-assert", runId = "local-run" } = {}) {
  if (phase === "deploy-and-assert") {
    const evidence = createS4StageGateEvidence();
    const report = verifyS4StageGate(evidence);
    return deepFreeze({
      ok: report.ok,
      phase,
      runId,
      fixture: S4_STAGE_GATE_FIXTURE,
      acceptanceRecord: S4_ACCEPTANCE_RECORD,
      providers: report.targetProviders,
      report,
    });
  }

  if (phase === "teardown") {
    return deepFreeze({
      ok: true,
      phase,
      runId,
      fixture: S4_STAGE_GATE_FIXTURE,
      providers: ["aws", "azure"],
    });
  }

  if (phase === "sweep-orphans") {
    return deepFreeze({
      ok: true,
      phase,
      selector: "hobo.dev/fixture=s4-stage-gate",
      maxAgeMinutes: 90,
    });
  }

  throw new Error(`unknown phase: ${phase}`);
}

function createCrossCloudMtlsEvidence(overrides = {}) {
  const authority = createX509SvidAuthority({
    trustDomain: "yard",
    ttlSeconds: 300,
    now: BASE_TIME,
    ...overrides.authority,
  });

  const awsApi = authority.issueWorkloadSvid({
    tenant: TENANT,
    bindle: BINDLE,
    resource: "api-aws",
    yard: "aws-us-east-1",
    attestation: attestation("api-aws"),
  });
  const azureWorker = authority.issueWorkloadSvid({
    tenant: TENANT,
    bindle: BINDLE,
    resource: "worker-azure",
    yard: "azure-eastus",
    attestation: attestation("worker-azure"),
  });

  const connection = establishMutualTls({
    client: azureWorker,
    server: awsApi,
    trustBundle: authority.trustBundle(),
    expectedTenant: TENANT,
    now: BASE_TIME + 1_000,
  });

  return deepFreeze({
    edge: {
      from: { provider: "azure", resource: "worker-azure", yard: "azure-eastus" },
      to: { provider: "aws", resource: "api-aws", yard: "aws-us-east-1" },
      tier: "private-interconnect",
      auth: "svid-mtls",
    },
    connection,
    clientSpiffeId: connection.clientSpiffeId,
    serverSpiffeId: connection.serverSpiffeId,
    trustBundle: authority.trustBundle(),
    ...overrides,
  });
}

function createJ3ProviderSwitchEvidence(portability, overrides = {}) {
  const bindleDigest = portability.bindle.digest;
  const before = {
    ordersProvider: "aws",
    campMapping: {
      orders: { provider: "aws", yard: "aws-us-east-1" },
      assets: { provider: "aws", yard: "aws-us-east-1" },
      api: { provider: "aws", yard: "aws-us-east-1" },
      frontend: { provider: "aws", yard: "aws-us-east-1" },
    },
    bindleDigest,
    sourceDigest: bindleDigest,
    mappingDigest: "sha256:camp-aws-all",
  };
  const after = {
    ordersProvider: "azure",
    campMapping: {
      orders: { provider: "azure", yard: "azure-eastus" },
      assets: { provider: "aws", yard: "aws-us-east-1" },
      api: { provider: "aws", yard: "aws-us-east-1" },
      frontend: { provider: "aws", yard: "aws-us-east-1" },
    },
    bindleDigest,
    sourceDigest: bindleDigest,
    mappingDigest: "sha256:camp-orders-azure-split",
    changedPaths: ["camp.mapping.orders"],
  };

  return deepFreeze({
    resourceId: "orders",
    journey: "J3",
    before,
    after,
    bindleUnchanged: before.bindleDigest === after.bindleDigest,
    appSourcesUnchanged: true,
    onlyCampMappingChanged:
      before.bindleDigest === after.bindleDigest &&
      before.sourceDigest === after.sourceDigest &&
      before.mappingDigest !== after.mappingDigest,
    ...overrides,
  });
}

function createMatchingResolutionEvidence(overrides = {}) {
  const catalog = createResourceCatalog({ id: "multi-cloud-shop-plan" });
  catalog.register({
    id: "platform.default",
    defaultDefinitions: [
      {
        id: "platform.database.default",
        type: "database",
        driver: "terraform",
        match: { envType: "production" },
        priority: 0,
      },
    ],
  });
  catalog.register({
    id: "@acme/postgres-ha-pack",
    defaultDefinitions: [
      {
        id: "pack.postgres.ha.prod",
        type: "database",
        driver: "terraform",
        match: {
          envType: "production",
          app: BINDLE,
          resourceClass: "ha",
        },
        priority: 10,
        pack: "@acme/postgres-ha-pack",
      },
    ],
  });

  const context = {
    resourceType: "database",
    envType: "production",
    env: "prod-us",
    app: BINDLE,
    tenant: TENANT,
    resourceClass: "ha",
    resourceId: "orders",
  };

  const decision = decideResourceDefinition({ catalog: catalog.snapshot(), context });
  const event = matchingDecisionToEvent(decision);

  return deepFreeze({
    installedPack: "@acme/postgres-ha-pack",
    context,
    decision,
    event,
    ...overrides,
  });
}

function validateCiLane(ciLane = {}, failures) {
  const gates = ciLane.gatedBy ?? [];
  const hasLabelGate = gates.some((gate) => gate.kind === "pull-request-label" && gate.label);
  const hasScheduleGate = gates.some((gate) => gate.kind === "schedule" && gate.cron);
  const hasManualGate = gates.some((gate) => gate.kind === "manual");

  if (
    ciLane.tag !== "camp" ||
    ciLane.costAware !== true ||
    ciLane.credentialed !== true ||
    !hasLabelGate ||
    !hasScheduleGate ||
    !hasManualGate
  ) {
    failures.push({
      code: "ci-lane.not-credentialed",
      message: "S4 stage gate drill must be camp-tagged, cost-aware, credentialed, and gated by label, schedule, and manual dispatch",
    });
  }
}

function validateCrossCloudMtls(crossCloudMtls = {}, failures) {
  const connection = crossCloudMtls.connection ;
  if (connection.ok !== true) {
    failures.push({
      code: "mtls.session-failed",
      message: "cross-cloud services must connect over SVID-keyed mTLS",
    });
    return;
  }

  if (!String(connection.clientSpiffeId ?? "").startsWith("spiffe://yard/")) {
    failures.push({
      code: "mtls.client-spiffe-missing",
      message: "client SPIFFE ID must be present in the mTLS session",
    });
  }
  if (!String(connection.serverSpiffeId ?? "").startsWith("spiffe://yard/")) {
    failures.push({
      code: "mtls.server-spiffe-missing",
      message: "server SPIFFE ID must be present in the mTLS session",
    });
  }
  if (crossCloudMtls.edge?.auth !== "svid-mtls") {
    failures.push({
      code: "mtls.auth-mode-wrong",
      message: "cross-cloud edge must use SVID-keyed mTLS",
    });
  }
  if (crossCloudMtls.edge?.from?.provider === crossCloudMtls.edge?.to?.provider) {
    failures.push({
      code: "mtls.not-cross-cloud",
      message: "S4 stage gate requires a cross-provider mTLS edge",
    });
  }
}

function validateJ3ProviderSwitch(j3 = {}, portability = {}, failures) {
  if (j3.journey !== "J3") {
    failures.push({
      code: "j3.journey-missing",
      message: "provider switch must follow the J3 optimize-a-boundary journey",
    });
    return;
  }

  if (!j3.onlyCampMappingChanged) {
    failures.push({
      code: "j3.camp-only-violation",
      message: "switching a resource provider must touch only the Camp mapping",
    });
  }

  if (!j3.bindleUnchanged || j3.before?.bindleDigest !== portability?.bindle?.digest) {
    failures.push({
      code: "j3.bindle-changed",
      message: "J3 provider switch must keep the Bindle byte-identical",
    });
  }

  const changed = new Set(j3.after?.changedPaths ?? []);
  if (!changed.has("camp.mapping.orders") || changed.has("bindle") || changed.has("src")) {
    failures.push({
      code: "j3.changed-paths-wrong",
      message: "only camp.mapping.orders may change when moving orders to azure",
    });
  }
}

function validateMatchingResolution(matching = {}, failures) {
  const decision = matching.decision ;
  const event = matching.event ;

  if (decision.ok !== true) {
    failures.push({
      code: "matching.decision-failed",
      message: "installed pack definition must win matching for multi-cloud-shop orders database",
    });
    return;
  }

  if (decision.winner?.id !== "pack.postgres.ha.prod") {
    failures.push({
      code: "matching.wrong-winner",
      message: `expected pack.postgres.ha.prod, got ${decision.winner?.id ?? "<missing>"}`,
    });
  }

  if (event.type !== "match.Decided" || event.data?.winner !== "pack.postgres.ha.prod") {
    failures.push({
      code: "matching.event-missing",
      message: "matching must emit match.Decided with the installed pack winner",
    });
  }

  if (matching.installedPack !== "@acme/postgres-ha-pack") {
    failures.push({
      code: "matching.pack-missing",
      message: "an installed Resource Pack must participate in resolution",
    });
  }
}

function attestation(resource) {
  const hexByResource = {
    "api-aws": "a".repeat(64),
    "worker-azure": "b".repeat(64),
  };
  return {
    tenant: TENANT,
    bindle: BINDLE,
    resource,
    measurement: `sha256:${hexByResource[resource] ?? "c".repeat(64)}`,
  };
}

function deepFreeze(value) {
  if (value && isJsonObject(value) && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
