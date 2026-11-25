import {
  contentAddressDeploymentSet,
  diffDeploymentSet,
  foldDeploymentProjections,
} from "../../../../../docs/design/proofs/hobo-50-deployment-set-delta/projection-model.ts";

import {
  CURRENT_SCHEMA_VERSION,
  validateControlPlaneEvent,
} from "../../control-plane-event-schema-contract/src/control-plane-events.js";
import {
  decideResourceDefinition,
  matchingDecisionToEvent,
} from "../../matching-engine-skeleton-contract/src/matching-engine.js";
import { createResourceCatalog } from "../../resource-definition-driver-contract/src/resource-definition-driver-contract.js";
import {
  createFixtureProviderResourcePack,
  createResourcePackTrustBoundary,
  createYard,
  hoboAddResourcePack,
} from "../../resource-pack-distribution-contract/src/resource-pack-distribution.js";
import { createFixtureSigningKey } from "../../signed-artifact-publish-install-contract/src/publish-install-contract.js";

export const RESOURCE_DEFINITIONS_MATCHING_PACKS_VERSION =
  "hobo.resource-definitions-matching-packs/v1";

export function createFixtureTrustBoundary(
  signingKey = createFixtureSigningKey({
    keyId: "resource-pack-builder-key",
    builderId: "spiffe://yard/builders/resource-pack-publisher",
  }),
) {
  return {
    signingKey,
    trustBoundary: createResourcePackTrustBoundary({
      trustedSigningKeys: [signingKey],
      trustedBuilderIds: [signingKey.builderId],
    }),
  };
}

export function createAwsResourcePack(signingKey) {
  return createFixtureProviderResourcePack({
    signingKey,
    name: "@hobo/aws-shop-defaults",
    definitions: [
      {
        id: "aws.shop.database",
        type: "database",
        provider: "aws",
        driver: "terraform",
        resourceClass: "rds-aurora-postgres",
        match: { envType: "production", app: "shop" },
        priority: 0,
      },
      {
        id: "aws.default.database",
        type: "database",
        provider: "aws",
        driver: "terraform",
        resourceClass: "rds-postgres",
        match: {},
        priority: 0,
      },
      {
        id: "aws.shop.api",
        type: "api",
        provider: "aws",
        driver: "terraform",
        resourceClass: "fargate-service",
        match: { envType: "production", app: "shop" },
        priority: 0,
      },
      {
        id: "aws.default.api",
        type: "api",
        provider: "aws",
        driver: "terraform",
        resourceClass: "fargate-service",
        match: {},
        priority: 0,
      },
    ],
  });
}

export function createAzureResourcePack(signingKey) {
  return createFixtureProviderResourcePack({
    signingKey,
    name: "@hobo/azure-shop-defaults",
    provider: {
      id: "azure",
      version: "3.0.0",
      codeDigest: "sha256:azure-provider-code-v1",
    },
    definitions: [
      {
        id: "azure.shop.database",
        type: "database",
        provider: "azure",
        driver: "terraform",
        resourceClass: "cosmos-postgres",
        match: { envType: "production", app: "shop" },
        priority: 0,
      },
      {
        id: "azure.default.database",
        type: "database",
        provider: "azure",
        driver: "terraform",
        resourceClass: "cosmos-postgres",
        match: {},
        priority: 0,
      },
      {
        id: "azure.shop.api",
        type: "api",
        provider: "azure",
        driver: "terraform",
        resourceClass: "container-app",
        match: { envType: "production", app: "shop" },
        priority: 0,
      },
      {
        id: "azure.default.api",
        type: "api",
        provider: "azure",
        driver: "terraform",
        resourceClass: "container-app",
        match: {},
        priority: 0,
      },
    ],
  });
}

export function installResourcePacks({ yard = createYard(), packs, trustBoundary }) {
  let nextYard = yard;
  const installed = [];

  for (const pack of packs) {
    const result = hoboAddResourcePack({ yard: nextYard, pack, trustBoundary });
    if (!result.ok) {
      return {
        ok: false,
        reasons: result.reasons,
        yard: nextYard,
        installed,
      };
    }
    nextYard = result.yard;
    installed.push(pack.name);
  }

  return {
    ok: true,
    reasons: [],
    yard: nextYard,
    installed,
  };
}

export function yardToMatchingCatalog(yard, { providerFilter = null } = {}) {
  const catalog = createResourceCatalog({ id: `${yard.yardId}-matching-catalog` });
  for (const entry of yard.catalog ?? []) {
    if (providerFilter && entry.provider !== providerFilter) {
      continue;
    }
    catalog.register({
      id: entry.id,
      type: entry.type,
      provider: entry.provider,
      driver: entry.driver,
      match: entry.match ?? {},
      priority: entry.priority ?? 0,
      with: entry.with ?? {},
      className: entry.resourceClass,
    });
  }
  return catalog;
}

export function matchResourceWithEvidence({ catalog, context, objective = "cost" }) {
  const decision = decideResourceDefinition({ catalog, context, objective });
  if (!decision.ok) {
    return { ok: false, decision, event: null };
  }

  const event = matchingDecisionToEvent(decision, {
    id: `evt-match-${context.resourceId ?? context.resourceType}`,
    causationId: "resource-definitions-matching-packs.plan",
  });
  const eventValidation = validateControlPlaneEvent(event);

  return {
    ok: true,
    decision,
    event,
    eventValid: eventValidation.ok,
    winnerScore: decision.ranking[0]?.specificity ?? 0,
    ranking: decision.ranking,
  };
}

export function planMultiCloudShop({
  yard,
  camps,
  manifest = defaultShopManifest(),
  objective = "cost",
}) {
  const plans = camps.map((camp) => {
    const catalog = yardToMatchingCatalog(yard, { providerFilter: camp.provider });
    const resources = [];
    const decisions = [];
    const matchEvents = [];

    for (const resource of manifest.resources) {
      const context = {
        resourceType: resource.type,
        resourceClass: resource.className ?? "standard",
        resourceId: resource.id,
        app: manifest.app,
        tenant: manifest.tenant,
        env: camp.env ?? camp.id,
        envType: camp.envType ?? "production",
      };
      const matched = matchResourceWithEvidence({ catalog, context, objective });
      if (!matched.ok) {
        return {
          campId: camp.id,
          ok: false,
          reason: matched.decision.reason,
          resources: [],
          decisions: [],
          matchEvents: [],
        };
      }
      resources.push({
        id: resource.id,
        type: resource.type,
        definitionId: matched.decision.winner.id,
        provider: matched.decision.winner.provider,
        driver: matched.decision.winner.driver,
        winnerScore: matched.winnerScore,
        catalogContentHash: matched.decision.catalogContentHash,
      });
      decisions.push(matched.decision);
      matchEvents.push(matched.event);
    }

    return {
      campId: camp.id,
      provider: camp.provider,
      ok: true,
      resources,
      decisions,
      matchEvents,
    };
  });

  return {
    ok: plans.every((plan) => plan.ok),
    schema: RESOURCE_DEFINITIONS_MATCHING_PACKS_VERSION,
    manifest,
    plans,
  };
}

export function promoteDeltaToSet({ baseSet, deltaChanges, deltaId, newSetId, deploymentPlanId, manifestDigest }) {
  const events = [
    {
      seq: 1,
      type: "set.Created",
      id: "evt-base-set",
      body: baseSet,
    },
    {
      seq: 2,
      type: "delta.Opened",
      id: "evt-delta-open",
      body: {
        deltaId,
        baseSetId: baseSet.setId,
        campId: baseSet.campId,
      },
    },
    {
      seq: 3,
      type: "delta.Updated",
      id: "evt-delta-update",
      body: {
        deltaId,
        changes: deltaChanges,
      },
    },
    {
      seq: 4,
      type: "delta.Applied",
      id: "evt-delta-apply",
      body: {
        deltaId,
        newSetId,
        deploymentPlanId,
        manifestDigest,
      },
    },
  ];

  const projection = foldDeploymentProjections(events);
  const newSet = projection.currentSetsByCamp[baseSet.campId];
  const contentAddress = contentAddressDeploymentSet(newSet);
  const beforeSet = projection.sets[baseSet.setId];
  const changes = diffDeploymentSet(beforeSet, newSet);
  const appliedEvent = deltaAppliedToEvent({
    deltaId,
    resultingSetId: newSetId,
    causationId: "evt-delta-update",
  });
  const appliedEventValidation = validateControlPlaneEvent(appliedEvent);

  return {
    projection,
    newSet,
    contentAddress,
    changes,
    delta: projection.deltas[deltaId],
    incrementalNodes: changes.map((change) => change.resourceId),
    appliedEvent,
    appliedEventValid: appliedEventValidation.ok,
  };
}

function deltaAppliedToEvent({ deltaId, resultingSetId, causationId }) {
  return {
    id: `evt-delta-applied-${deltaId}`,
    type: "delta.Applied",
    schemaVersion: CURRENT_SCHEMA_VERSION,
    tenant: "tenant-hobo",
    seq: 4,
    time: "2026-07-02T00:00:00.000Z",
    actor: { kind: "service", id: "yard/set-store" },
    correlationId: `corr-${deltaId}`,
    causationId,
    data: {
      deltaId,
      resultingSetId,
    },
  };
}

export function defaultShopManifest() {
  return {
    schema: "hobo.manifest/v1",
    app: "shop",
    tenant: "acme",
    resources: [
      { id: "shop.db", type: "database", className: "ha" },
      { id: "shop.api", type: "api", className: "standard" },
    ],
  };
}

export function defaultMultiCloudCamps() {
  return [
    { id: "prod-aws", provider: "aws", env: "prod-us", envType: "production" },
    { id: "prod-azure", provider: "azure", env: "prod-eu", envType: "production" },
  ];
}
