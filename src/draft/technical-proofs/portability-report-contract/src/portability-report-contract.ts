export const PORTABILITY_REPORT_VERSION = "hobo.portabilityReport/v1";
export const DEPLOYMENT_PLANNED_EVENT = "deployment.Planned";

const REPORT_REQUIRED_CATEGORIES = new Set([
  "provider-option",
  "raw-dialect-leak",
  "cross-paradigm-feature",
  "static-key",
  "external-dependency",
  "adopted-dependency"
]);

const ZERO_SECRET_EXCEPTION_CATEGORIES = new Set([
  "static-key",
  "external-dependency",
  "adopted-dependency"
]);

const NON_PORTABLE_SEVERITIES = new Set(["target-scoped", "blocking", "critical"]);

export function createPortablePlan() {
  return {
    id: "portable-object-store-plan",
    targetProviders: ["aws", "azure"],
    resources: [
      {
        id: "assets",
        type: "objectStore",
        provider: "portable-fixture",
        inputs: {
          durability: "regional"
        },
        nonPortableEvidence: []
      }
    ]
  };
}

export function createProviderOptionPlan() {
  return withEvidence(createPortablePlan(), "assets", {
    category: "provider-option",
    provider: "aws",
    option: "r2-compatible-mode"
  });
}

export function createRawDialectPlan() {
  return withEvidence(createPortablePlan(), "assets", {
    category: "raw-dialect-leak",
    driver: "terraform",
    field: "aws_s3_bucket_accelerate_configuration"
  });
}

export function createCrossParadigmPlan() {
  return withEvidence(createPortablePlan(), "assets", {
    category: "cross-paradigm-feature",
    feature: "postgres-vector-index",
    sourceParadigm: "relational",
    targetParadigm: "document"
  });
}

export function createStaticKeyPlan() {
  return withEvidence(createPortablePlan(), "assets", {
    category: "static-key",
    credentialRef: "env.AWS_ACCESS_KEY_ID",
    federatedAlternative: "workload-svid"
  });
}

export function createExternalDependencyPlan() {
  const plan = createPortablePlan();
  plan.id = "brownfield-coexistence-plan";
  plan.resources = [
    {
      id: "legacy-db",
      type: "database",
      provider: "external",
      nonPortableEvidence: [
        {
          category: "external-dependency",
          dependencyKind: "external",
          target: "terraform://prod/legacy-db"
        }
      ]
    },
    {
      id: "imported-bucket",
      type: "objectStore",
      provider: "aws",
      nonPortableEvidence: [
        {
          category: "adopted-dependency",
          dependencyKind: "adopted",
          target: "pulumi://prod/assets"
        }
      ]
    }
  ];
  return plan;
}

export function realizeWithPortabilityReport(plan, options = {}) {
  const markers = collectRequiredMarkers(plan);
  const omitted = new Set(options.omitCategories ?? []);
  const omittedZeroSecret = new Set(options.omitZeroSecretCategories ?? []);
  const entries = markers.filter((marker) => !omitted.has(marker.category)).map(toReportEntry);
  const zeroSecretExceptions = markers
    .filter((marker) => ZERO_SECRET_EXCEPTION_CATEGORIES.has(marker.category))
    .filter((marker) => !omittedZeroSecret.has(marker.category))
    .map(toZeroSecretException);
  const portabilityReport = {
    apiVersion: PORTABILITY_REPORT_VERSION,
    planId: plan.id,
    entries,
    zeroSecretExceptions
  };

  return {
    provider: "fixture-provider",
    resourcePlan: structuredClone(plan),
    iacProgram: {
      apiVersion: "hobo.iacProgram/v1",
      nodes: plan.resources.map((resource) => ({
        id: resource.id,
        type: resource.type,
        provider: resource.provider,
        nonPortableEvidence: structuredClone(resource.nonPortableEvidence ?? [])
      }))
    },
    deploymentPlanned: {
      type: DEPLOYMENT_PLANNED_EVENT,
      planId: plan.id,
      portabilityReport
    }
  };
}

export function validatePortabilityReport(realized) {
  const errors = [];
  const markers = collectObservedMarkers(realized);
  const entries = realized.deploymentPlanned?.portabilityReport?.entries ?? [];
  const zeroSecretExceptions = realized.deploymentPlanned?.portabilityReport?.zeroSecretExceptions ?? [];
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const zeroSecretByMarkerId = new Map(zeroSecretExceptions.map((entry) => [entry.markerId, entry]));

  if (realized.deploymentPlanned?.type !== DEPLOYMENT_PLANNED_EVENT) {
    errors.push(`expected ${DEPLOYMENT_PLANNED_EVENT}`);
  }
  if (realized.deploymentPlanned?.portabilityReport?.apiVersion !== PORTABILITY_REPORT_VERSION) {
    errors.push(`expected portability report ${PORTABILITY_REPORT_VERSION}`);
  }

  for (const marker of markers) {
    if (!REPORT_REQUIRED_CATEGORIES.has(marker.category)) continue;

    const entry = entryById.get(marker.id);
    if (!entry) {
      errors.push(`unreported ${marker.category} marker ${marker.id}`);
      continue;
    }

    if (!NON_PORTABLE_SEVERITIES.has(entry.severity)) {
      errors.push(`${marker.category} marker ${marker.id} uses invalid severity ${entry.severity}`);
    }
    if (marker.category === "cross-paradigm-feature" && entry.severity === "portable") {
      errors.push(`cross-paradigm marker ${marker.id} cannot be portable`);
    }
    if (ZERO_SECRET_EXCEPTION_CATEGORIES.has(marker.category) && !zeroSecretByMarkerId.has(marker.id)) {
      errors.push(`${marker.category} marker missing zero-secret audit exception: ${marker.id}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

export function createGateInputFromPlan(deploymentPlanned) {
  return {
    planId: deploymentPlanned.planId,
    nonPortableSurface: deploymentPlanned.portabilityReport
  };
}

function withEvidence(plan, resourceId, evidence) {
  return {
    ...plan,
    resources: plan.resources.map((resource) =>
      resource.id === resourceId
        ? {
            ...resource,
            nonPortableEvidence: [...(resource.nonPortableEvidence ?? []), evidence]
          }
        : resource
    )
  };
}

function collectRequiredMarkers(plan) {
  return (plan.resources ?? []).flatMap((resource) =>
    (resource.nonPortableEvidence ?? []).map((evidence) => ({
      ...evidence,
      id: markerId(resource, evidence),
      resourceId: resource.id,
      resourceType: resource.type
    }))
  );
}

function collectObservedMarkers(realized) {
  const nodes = realized.iacProgram?.nodes;
  if (Array.isArray(nodes)) {
    return nodes.flatMap((node) =>
      (node.nonPortableEvidence ?? []).map((evidence) => ({
        ...evidence,
        id: markerId(node, evidence),
        resourceId: node.id,
        resourceType: node.type
      }))
    );
  }

  return collectRequiredMarkers(realized.resourcePlan ?? { resources: [] });
}

function markerId(resource, evidence) {
  switch (evidence.category) {
    case "provider-option":
      return `${resource.id}.provider-option.${evidence.provider}.${evidence.option}`;
    case "raw-dialect-leak":
      return `${resource.id}.raw-dialect.${evidence.driver}.${evidence.field}`;
    case "cross-paradigm-feature":
      return `${resource.id}.cross-paradigm.${evidence.feature}`;
    case "static-key":
      return `${resource.id}.static-key.${evidence.credentialRef}`;
    case "external-dependency":
      return `${resource.id}.external.${evidence.target}`;
    case "adopted-dependency":
      return `${resource.id}.adopted.${evidence.target}`;
    default:
      return `${resource.id}.${evidence.category}`;
  }
}

function toReportEntry(marker) {
  switch (marker.category) {
    case "provider-option":
      return {
        id: marker.id,
        category: marker.category,
        severity: "target-scoped",
        resourceId: marker.resourceId,
        provider: marker.provider,
        path: `resources.${marker.resourceId}.with.${marker.provider}.${marker.option}`,
        detail: "Provider-specific .with option requires target provider support.",
        gateEffect: "target-provider-must-satisfy"
      };
    case "raw-dialect-leak":
      return {
        id: marker.id,
        category: marker.category,
        severity: "blocking",
        resourceId: marker.resourceId,
        driver: marker.driver,
        path: `resources.${marker.resourceId}.raw.${marker.driver}.${marker.field}`,
        detail: "Raw driver dialect escapes the agnostic provider contract.",
        gateEffect: "target-provider-must-satisfy"
      };
    case "cross-paradigm-feature":
      return {
        id: marker.id,
        category: marker.category,
        severity: "blocking",
        resourceId: marker.resourceId,
        path: `resources.${marker.resourceId}.features.${marker.feature}`,
        detail: "Feature crosses projection-sink paradigm classes and narrows portability.",
        gateEffect: "same-paradigm-target-required"
      };
    case "static-key":
      return {
        id: marker.id,
        category: marker.category,
        severity: "critical",
        resourceId: marker.resourceId,
        path: `resources.${marker.resourceId}.credentials.${marker.credentialRef}`,
        detail: "Static credential appears where brokered federation exists.",
        gateEffect: "zero-secret-exception-required"
      };
    case "external-dependency":
    case "adopted-dependency":
      return {
        id: marker.id,
        category: marker.category,
        severity: "target-scoped",
        resourceId: marker.resourceId,
        path: `resources.${marker.resourceId}.${marker.dependencyKind}`,
        detail: "Brownfield dependency is outside the managed conformance boundary.",
        gateEffect: "excluded-from-portability-claim"
      };
    default:
      throw new Error(`unknown portability marker category ${marker.category}`);
  }
}

function toZeroSecretException(marker) {
  return {
    markerId: marker.id,
    category: marker.category,
    resourceId: marker.resourceId,
    reason:
      marker.category === "static-key"
        ? "static credential where federation exists"
        : "brownfield resource is outside brokered identity boundary"
  };
}
