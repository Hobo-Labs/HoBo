import {
  createSamplePlanFixture,
  runHoboPlan,
} from "../../../../technical-proofs/hobo-plan-preview-contract/src/plan-preview.js";
import {
  createHoboUpConvergence,
  makeUpEvent,
  sampleSnapshopProject,
} from "../../../../technical-proofs/hobo-up-convergence-contract/src/up-convergence.js";
import { createDownLifecycle } from "../../../../technical-proofs/hobo-down-lifecycle-contract/src/down-lifecycle.js";
import {
  createFixtureProviderSts,
  createOidcFederationBroker,
} from "../../../../technical-proofs/oidc-federation-sts-contract/src/oidc-federation-sts.js";
import {
  openPullRequestPreview,
  reapExpiredPreview,
} from "../../../../technical-proofs/preview-ephemeral-environments-contract/src/preview-environments.js";

export const GITOPS_CI_JOURNEY_CONTRACT_VERSION = "hobo.gitops-ci-journey/v1";

const NOW = "2026-06-28T08:50:00.000Z";
const TENANT = "acme";
const PROJECT = "snapshop";
const REPOSITORY = "tyler-r-kendrick/hobo";

export async function runScriptedGitOpsCiScenario({
  prNumber = 42,
  headSha = "sha-good-20260628",
  baseSha = "sha-base-20260628",
} = {}) {
  const identity = await exchangeGitOpsToken();
  if (identity.status !== "granted") {
    return {
      contractVersion: GITOPS_CI_JOURNEY_CONTRACT_VERSION,
      status: "blocked",
      identity,
    };
  }

  const plan = runHoboPlan(["--camp", "staging", "--json"], samplePlanFixture());
  const staging = await runUp({
    camp: "staging",
    project: sampleProject({ currentRevision: headSha }),
  });
  const preview = await runPreviewLifecycle({ prNumber, headSha, baseSha });
  const production = await runUp({
    camp: "prod",
    to: headSha,
    project: sampleProject({ currentRevision: headSha }),
    evaluateGate: knownGoodGate(new Set([headSha])),
  });

  return {
    contractVersion: GITOPS_CI_JOURNEY_CONTRACT_VERSION,
    commandOrder: [
      "hobo plan --camp staging",
      "hobo up --camp staging",
      `hobo up --camp pr-${prNumber}`,
      `hobo down --camp pr-${prNumber}`,
      `hobo up --camp prod --to ${headSha}`,
    ],
    prPlan: {
      readOnly: plan.preview.sideEffectEvents.length === 0,
      postedComment: {
        kind: "hobo.plan",
        camp: "staging",
        exitCode: plan.exitCode,
        body: plan.stdout,
      },
      sideEffectEvents: plan.preview.sideEffectEvents,
      diff: {
        status: plan.preview.status,
        summary: plan.preview.summary,
        planHash: plan.preview.planHash,
      },
    },
    staging: {
      status: staging.status,
      revision: staging.revision,
      events: staging.events,
    },
    preview,
    production: {
      status: production.status,
      revision: production.revision,
      revisionSelector: revisionSelector(production.events),
      events: production.events,
    },
    identity: {
      mode: "keyless-oidc",
      persistedSecretCount: identity.persistedSecretCount,
      tokenEventTypes: identity.tokenEventTypes,
      credentialRef: identity.credentialRef,
    },
    scopeOut: {
      progressiveDeliveryHarnessUsed: false,
      oidcBrokerInternalsImplemented: false,
      ciProviderRunnerFabricImplemented: false,
    },
  };
}

export async function runCanDeploySkewScenario() {
  const result = await runUp({
    camp: "prod",
    to: "sha-breaking-provider",
    project: sampleProject({ currentRevision: "sha-breaking-provider" }),
    evaluateGate: () => ({
      status: "failed",
      code: "can-deploy.skew",
      reason: "consumer cart-api cannot take checkout-contract v2 yet",
      fix: "dual-publish checkout-contract v1+v2 and deploy cart-api before prod promotion",
    }),
  });
  const rejected = lastEvent(result.events, "deployment.PlanRejected");

  return {
    status: result.status,
    applied: result.applied,
    reason: {
      code: rejected.data.code,
      consumers: ["cart-api"],
      message: rejected.data.reason,
    },
    fix: {
      summary: rejected.data.fix,
    },
    events: result.events,
    mutationEvents: mutationEvents(result.events),
  };
}

export async function runRollbackScenario({
  failedRevision = "sha-bad-20260628",
  lastGoodRevision = "sha-good-previous",
} = {}) {
  const eventLog = [
    makeUpEvent({
      id: "up-event-last-good",
      type: "deployment.UpCompleted",
      seq: 1,
      time: NOW,
      deploymentId: "dep-snapshop",
      campId: "prod",
      correlationId: "up:dep-snapshop:prod:last-good",
      causationId: "up-event-last-set",
      data: {
        revision: lastGoodRevision,
        liveUrl: "https://prod.snapshop.hobo.dev",
        targetKey: `prod:recreate:${lastGoodRevision}:manifest-good`,
      },
    }),
    makeUpEvent({
      id: "up-event-failed-revision",
      type: "deployment.PlanRejected",
      seq: 2,
      time: NOW,
      deploymentId: "dep-snapshop",
      campId: "prod",
      correlationId: "up:dep-snapshop:prod:failed",
      causationId: "up-event-last-good",
      data: {
        revision: failedRevision,
        code: "prod-consumer-skew",
        reason: "failed revision never became last-good",
      },
    }),
  ];
  const result = await runUp({
    camp: "prod",
    rollback: true,
    project: sampleProject({ currentRevision: failedRevision }),
    eventLog,
  });

  return {
    status: result.status,
    command: "hobo up --camp prod --rollback",
    revision: result.revision,
    revisionSelector: revisionSelector(result.events),
    lastGoodRevision,
    failedRevision,
    events: result.events,
  };
}

export async function runInvalidOidcScenario({ reason = "expired" } = {}) {
  const identity = await exchangeGitOpsToken({
    expired: reason === "expired",
    forged: reason === "forged",
  });

  return {
    status: "blocked",
    identity: {
      status: "rejected",
      reason: identity.reasonCode,
      rawReason: identity.rawReason,
      events: identity.events,
    },
    executedCommands: [],
    mutationEvents: [],
  };
}

export async function runWrongRevisionScenario({ requestedRevision = "sha-unknown" } = {}) {
  const result = await runUp({
    camp: "prod",
    to: requestedRevision,
    project: sampleProject({ currentRevision: requestedRevision }),
    evaluateGate: knownGoodGate(new Set(["sha-good-20260628"])),
  });
  const rejected = lastEvent(result.events, "deployment.PlanRejected");

  return {
    status: result.status,
    requestedRevision,
    applied: result.applied,
    reason: {
      code: rejected.data.code,
      message: rejected.data.reason,
    },
    fix: {
      summary: rejected.data.fix,
    },
    events: result.events,
    mutationEvents: mutationEvents(result.events),
  };
}

export function surfaceDriftReconcileEvent({
  camp = "staging",
  resourceId,
  actualDigest,
  desiredDigest,
} = {}) {
  if (!resourceId) {
    throw new Error("resourceId is required");
  }

  const event = {
    apiVersion: GITOPS_CI_JOURNEY_CONTRACT_VERSION,
    id: `drift:${camp}:${resourceId}`,
    type: "resource.DriftDetected",
    time: NOW,
    campId: camp,
    data: {
      resourceId,
      actualDigest,
      desiredDigest,
      source: "gitops-operator",
    },
  };

  return {
    event,
    reconcilePr: {
      action: "open",
      title: `Reconcile drift for ${resourceId} in ${camp}`,
      body: `Observed ${actualDigest}; git expects ${desiredDigest}. Re-run hobo up after review.`,
      targetBranch: `reconcile/${camp}/${resourceId.replaceAll(":", "-")}`,
    },
    silentApply: false,
  };
}

async function runUp({
  camp,
  to = null,
  rollback = false,
  project = sampleProject(),
  eventLog = [],
  evaluateGate = () => ({ status: "passed", gateId: "can-deploy:passed" }),
} = {}) {
  const up = createHoboUpConvergence({
    now: () => NOW,
    idFactory: deterministicIds(),
    evaluateGate,
  });

  return up.run({
    project,
    flags: {
      camp,
      to,
      rollback,
      json: true,
    },
    eventLog,
  });
}

async function runPreviewLifecycle({ prNumber, headSha, baseSha }) {
  const opened = openPullRequestPreview(
    {
      tenant: TENANT,
      project: PROJECT,
      repository: REPOSITORY,
      pullRequest: {
        number: prNumber,
        headSha,
        baseSha,
      },
      baselineCampId: "staging",
      baselineSetId: `set:${baseSha}`,
      baselineResources: [
        { id: "catalog", provider: "local.kv" },
        { id: "api", provider: "local.service" },
      ],
      resourceRequests: [
        ephemeralResource("catalog", "key-value"),
        ephemeralResource("api", "http-service"),
      ],
    },
    { now: new Date(NOW), ttlHours: 72 },
  );
  const down = createDownLifecycle({
    now: () => NOW,
    idFactory: deterministicIds(),
  });
  const teardown = await down.run({
    topology: previewTopology(opened.camp.id),
    campId: opened.camp.id,
    destroyResource: async (resource) => ({
      providerId: "preview-iac",
      externalId: `preview-${resource.id}`,
    }),
  });
  const abandonedSweep = reapExpiredPreview(opened, {
    now: new Date("2026-07-01T09:00:00.000Z"),
  });

  return {
    opened: {
      campId: opened.camp.id,
      url: opened.previewUrl,
      eventTypes: opened.events.map((event) => event.type),
    },
    teardown: {
      status: teardown.status,
      campId: opened.camp.id,
      eventTypes: teardown.events.map((event) => event.type),
      removedResourceIds: teardown.removedResources.map((resource) => resource.id),
    },
    abandonedSweep: {
      action: abandonedSweep.action,
      eventTypes: abandonedSweep.events.map((event) => event.type),
    },
  };
}

async function exchangeGitOpsToken({ expired = false, forged = false } = {}) {
  const providerSts = createFixtureProviderSts({
    expiresAt: "2026-06-28T09:10:00.000Z",
  });
  const events = [];
  const broker = createOidcFederationBroker({
    issuer: "https://identity.hobo.dev",
    now: () => new Date(NOW),
    maxTtlSeconds: 600,
    idFactory: deterministicIds(),
    providerSts,
    eventSink: (event) => events.push(event),
  });
  const result = await broker.requestToken(baseOidcRequest({
    svid: {
      ...baseSvid(),
      expiresAt: expired ? "2026-06-28T08:49:59.000Z" : "2026-06-28T09:20:00.000Z",
      scope: forged ? [] : baseSvid().scope,
    },
  }));

  if (!result.ok) {
    return {
      status: "rejected",
      reasonCode: normalizeIdentityReason(result.reason),
      rawReason: result.reason,
      events: result.events,
      providerStsCalls: providerSts.calls.length,
    };
  }

  return {
    status: "granted",
    credentialRef: result.credential.credentialRef,
    persistedSecretCount: result.events.reduce(
      (count, event) => count + (event.data.staticCredentialReads ?? 0),
      0,
    ),
    tokenEventTypes: result.events.map((event) => event.type),
    events: result.events,
    providerStsCalls: providerSts.calls.length,
  };
}

function samplePlanFixture() {
  return createSamplePlanFixture({
    providerDefinitions: [
      {
        id: "staging-bucket",
        port: "bucket",
        provider: "local.bucket",
        cloud: "local",
        driver: "runtime-local",
        costMonthlyUsd: 0,
        reason: "runtime-local staging bucket",
        supportedCapabilities: ["object-storage"],
        match: { camp: "staging" },
        priority: 20,
      },
      {
        id: "staging-http",
        port: "http",
        provider: "local.http",
        cloud: "local",
        driver: "runtime-local",
        costMonthlyUsd: 0,
        reason: "runtime-local staging http",
        supportedCapabilities: ["http-service"],
        match: { camp: "staging" },
        priority: 30,
      },
    ],
  });
}

function sampleProject(overrides = {}) {
  return sampleSnapshopProject({
    currentRevision: "sha-good-20260628",
    ...overrides,
  });
}

function knownGoodGate(knownGoodRevisions) {
  return ({ revision }) => {
    if (!knownGoodRevisions.has(revision.revision)) {
      return {
        status: "failed",
        code: "revision.not-known-good",
        reason: `revision ${revision.revision} is not in the known-good set`,
        fix: "promote only a revision proven by staging and can-deploy evidence",
      };
    }
    return { status: "passed", gateId: "known-good:passed" };
  };
}

function baseOidcRequest(overrides = {}) {
  return {
    requestId: "req-hobo-208-gitops",
    provider: "aws-prod",
    subject: {
      kind: "agent",
      id: "agent:gitops",
      delegatedBy: { kind: "user", id: "user:release-manager" },
    },
    svid: baseSvid(),
    scope: { port: "deployment", resource: "snapshop/prod", action: "write" },
    flow: {
      type: "oidc-federation",
      providerKind: "aws",
      audience: "arn:aws:iam::123456789012:role/hobo-gitops-writer",
      exchange: "sts:AssumeRoleWithWebIdentity",
      roleArn: "arn:aws:iam::123456789012:role/hobo-gitops-writer",
      trust: { oidcDiscovery: "https://identity.hobo.dev/.well-known/openid-configuration" },
    },
    ...overrides,
  };
}

function baseSvid() {
  return {
    svidRef: "identity://svid/hobo-208-gitops",
    issuer: "https://identity.hobo.dev",
    subject: "spiffe://hobo/acme/agent/gitops",
    tenant: "acme",
    audience: "hobo-broker",
    expiresAt: "2026-06-28T09:20:00.000Z",
    scope: [
      { port: "deployment", resource: "snapshop/prod", actions: ["write"] },
    ],
  };
}

function ephemeralResource(name, capability) {
  return {
    name,
    capability,
    variants: [
      {
        envType: "ephemeral",
        provider: "local.preview",
        ttl: "72h",
      },
    ],
  };
}

function previewTopology(campId) {
  return {
    deploymentId: "dep-snapshop",
    tenantId: "tenant-acme",
    camps: [
      { id: campId, environmentType: "preview" },
      { id: "staging", environmentType: "staging" },
    ],
    resources: [
      { id: "catalog", campId, deps: [], state: "Provisioned" },
      { id: "api", campId, deps: ["catalog"], state: "Provisioned" },
    ],
  };
}

function revisionSelector(events) {
  return lastEvent(events, "deployment.UpStarted").data.revisionSelector;
}

function lastEvent(events, type) {
  const event = [...events].reverse().find((candidate) => candidate.type === type);
  if (!event) {
    throw new Error(`missing event ${type}`);
  }
  return event;
}

function mutationEvents(events) {
  return events.filter((event) => [
    "resource.Provisioned",
    "deployment.SetApplied",
    "deployment.UpCompleted",
  ].includes(event.type));
}

function normalizeIdentityReason(reason) {
  if (reason === "expired SVID cannot be exchanged") {
    return "svid.expired";
  }
  if (reason === "requested scope is outside caller SVID scope") {
    return "svid.scope-denied";
  }
  return "svid.rejected";
}

function deterministicIds() {
  let next = 1;
  return (prefix) => `${prefix}-${next++}`;
}
