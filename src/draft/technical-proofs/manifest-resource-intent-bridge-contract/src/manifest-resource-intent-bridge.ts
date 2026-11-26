import { isJsonObject, type JsonObject } from "./json.js";
export const MANIFEST_SCHEMA = "hobo.manifest/v1";

const FORBIDDEN_INTENT_KEYS = new Set([
  "provider",
  "providerId",
  "cloud",
  "sku",
  "region",
  "account",
  "accountId",
  "with",
]);

export type ManifestResource = {
  type: string;
  port?: string;
  paradigm?: string;
  allow?: string[];
  bind?: string[];
  links?: Array<{ import?: string; to?: string }>;
  annotations?: JsonObject;
};

export type HoboManifest = {
  schema: string;
  resources: Record<string, ManifestResource>;
};

// domain-view: parse-produced draft-proof record; its wire form is the DeployContext proto message in data-models/.
export type DeployContext = {
  tenant: string;
  workspace: string;
  environment: string;
  routingObjective?: string;
  budget?: {
    amount: number;
    currency: string;
    period: string;
    softLimitBehavior?: string;
    hardLimitBehavior?: string;
  };
};

export type ResourceIntent = {
  schemaVersion: string;
  resourceName: string;
  owner: {
    tenant: string;
    workspace: string;
    environment: string;
  };
  capability: {
    category: string;
    requirements: string[];
  };
  budget: {
    amount: number;
    currency: string;
    period: string;
    softLimitBehavior: string;
    hardLimitBehavior: string;
  };
  constraints: {
    colocateWith: string[];
    maxCost?: number;
  };
  routingObjective: string;
};

export function lowerManifestToResourceIntents(
  manifest: HoboManifest,
  deployContext: DeployContext,
): ResourceIntent[] {
  assertValidManifest(manifest);
  return Object.entries(manifest.resources).map(([resourceName, resource]) =>
    lowerResourceNode(resourceName, resource, manifest, deployContext),
  );
}

function assertValidManifest(manifest: HoboManifest) {
  if (manifest.schema !== MANIFEST_SCHEMA) {
    throw new Error(`unsupported manifest schema: ${manifest.schema}`);
  }
  if (!manifest.resources || Object.keys(manifest.resources).length === 0) {
    throw new Error("manifest has no resources");
  }
}

function lowerResourceNode(
  resourceName: string,
  resource: ManifestResource,
  manifest: HoboManifest,
  deployContext: DeployContext,
): ResourceIntent {
  const intent: ResourceIntent = {
    schemaVersion: "finops.resource-intent/v1",
    resourceName,
    owner: {
      tenant: deployContext.tenant,
      workspace: deployContext.workspace,
      environment: deployContext.environment,
    },
    capability: {
      category: resource.port ?? resource.type,
      requirements: collectRequirements(resource),
    },
    budget: {
      amount: deployContext.budget?.amount ?? 0,
      currency: deployContext.budget?.currency ?? "USD",
      period: deployContext.budget?.period ?? "monthly",
      softLimitBehavior: deployContext.budget?.softLimitBehavior ?? "warn",
      hardLimitBehavior: deployContext.budget?.hardLimitBehavior ?? "deny",
    },
    constraints: {
      colocateWith: collectColocationDeps(resourceName, resource, manifest),
    },
    routingObjective: deployContext.routingObjective ?? "cost",
  };

  assertProviderNeutral(intent, resource);
  return intent;
}

function collectRequirements(resource: ManifestResource): string[] {
  const requirements = new Set<string>();
  if (resource.paradigm) {
    requirements.add(`paradigm:${resource.paradigm}`);
  }
  for (const verb of resource.allow ?? []) {
    requirements.add(`verb:${verb}`);
  }
  const scaling = resource.annotations?.scaling;
  if (scaling && isJsonObject(scaling)) {
    requirements.add("scaling:bounded");
  }
  return [...requirements];
}

function collectColocationDeps(
  resourceName: string,
  resource: ManifestResource,
  manifest: HoboManifest,
): string[] {
  const deps = new Set<string>();
  for (const target of resource.bind ?? []) {
    if (target !== resourceName && manifest.resources[target]) {
      deps.add(target);
    }
  }
  for (const link of resource.links ?? []) {
    const target = link.to;
    if (target && target !== resourceName && manifest.resources[target]) {
      deps.add(target);
    }
  }
  return [...deps].sort();
}

function assertProviderNeutral(
  intent: ResourceIntent,
  resource: ManifestResource,
) {
  const serialized = JSON.stringify(intent);
  for (const key of FORBIDDEN_INTENT_KEYS) {
    if (serialized.includes(`"${key}"`)) {
      throw new Error(`provider leakage in ResourceIntent: ${key}`);
    }
  }
  const withBlock = resource.annotations?.with;
  if (withBlock && serialized.includes("aws") ) {
    throw new Error("provider leakage in ResourceIntent: provider annotation escaped");
  }
}
