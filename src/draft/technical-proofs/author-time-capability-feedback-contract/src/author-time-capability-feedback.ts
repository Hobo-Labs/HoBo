import { isJsonString, isJsonObject } from "./json.js";
export const AUTHOR_TIME_CAPABILITY_FEEDBACK_SCHEMA = "hobo.author-time-capability-feedback/v1";

const STRICTNESS = new Set(["require", "prefer"]);
const STABILITY = new Set(["stable", "preview", "experimental", "deprecated"]);

export function analyzeAuthorTimeCapabilityFeedback({
  catalogContentHash,
  deployCatalogContentHash,
  resource,
  requests,
  providers
}) {
  assertString(catalogContentHash, "catalogContentHash");
  assertResource(resource);
  const normalizedRequests = normalizeRequests(requests);
  const normalizedProviders = normalizeProviders(providers);
  const selectedProvider = normalizedProviders.get(resource.selectedProviderId);
  const findings = [];

  if (!selectedProvider) {
    for (const request of normalizedRequests) {
      findings.push(missingFinding({ resource, request, providers: normalizedProviders }));
    }
  } else {
    for (const request of normalizedRequests) {
      const capability = selectedProvider.capabilities.find((candidate) =>
        candidate.port === request.port && candidate.feature === request.feature
      );

      if (!capability) {
        findings.push(missingFinding({ resource, request, providers: normalizedProviders }));
        continue;
      }

      if (capability.stability !== "stable") {
        findings.push(stabilityFinding({ resource, request, capability }));
      }
    }
  }

  if (deployCatalogContentHash !== undefined && deployCatalogContentHash !== catalogContentHash) {
    findings.push({
      code: "catalog.snapshot.stale",
      severity: "warning",
      resourceId: resource.id,
      providerId: resource.selectedProviderId,
      message: `author catalog ${catalogContentHash} differs from deploy catalog ${deployCatalogContentHash}; refresh author-time feedback before relying on it.`,
      remediation: {
        kind: "refresh-catalog",
        message: "Refresh the catalog snapshot; deploy-time PlanRejected remains authoritative.",
        providerIds: []
      }
    });
  }

  const report = {
    schema: AUTHOR_TIME_CAPABILITY_FEEDBACK_SCHEMA,
    ok: findings.every((finding) => finding.severity !== "error"),
    deployGateRequired: true,
    catalogContentHash,
    resource: {
      id: resource.id,
      type: resource.type,
      selectedProviderId: resource.selectedProviderId
    },
    findings
  };

  return {
    ...report,
    surfaces: {
      codegenDiagnostics: findings,
      doctor: {
        schema: AUTHOR_TIME_CAPABILITY_FEEDBACK_SCHEMA,
        findings
      }
    }
  };
}

export function renderHoboPlanFeedback(report) {
  if (!report?.findings || report.findings.length === 0) {
    return "";
  }

  return report.findings.map((finding) => {
    const prefix = finding.severity === "error" ? "error" : "warning";
    const remediation = finding.remediation?.message
      ? ` ${lowercaseFirst(finding.remediation.message)}`
      : "";
    return `${prefix}: ${finding.message}${remediation}`;
  }).join("\n");
}

function missingFinding({ resource, request, providers }) {
  const providerIds = [...providers.values()]
    .filter((provider) => provider.capabilities.some((capability) =>
      capability.port === request.port && capability.feature === request.feature
    ))
    .map((provider) => provider.id)
    .sort();
  const severity = request.strictness === "require" ? "error" : "warning";
  const code = request.strictness === "require"
    ? "capability.require.unsatisfied"
    : "capability.prefer.degraded";
  const capabilityRef = `${request.port}.${request.feature}`;

  return {
    code,
    severity,
    resourceId: resource.id,
    providerId: resource.selectedProviderId,
    port: request.port,
    feature: request.feature,
    strictness: request.strictness,
    message: `${resource.selectedProviderId} does not support ${capabilityRef} ${request.strictness === "require" ? "required" : "preferred"} by ${resource.id}.`,
    remediation: remediationFor(capabilityRef, providerIds)
  };
}

function stabilityFinding({ resource, request, capability }) {
  return {
    code: `capability.stability.${capability.stability}`,
    severity: "warning",
    resourceId: resource.id,
    providerId: resource.selectedProviderId,
    port: request.port,
    feature: request.feature,
    strictness: request.strictness,
    message: `${resource.selectedProviderId} supports ${request.port}.${request.feature} as ${capability.stability}; pinned, may change, and policy may deny it in production.`,
    remediation: {
      kind: "stability-warning",
      message: "Pin the interface version and keep the deploy-time PlanRejected gate in place.",
      providerIds: []
    }
  };
}

function remediationFor(capabilityRef, providerIds) {
  if (providerIds.length === 0) {
    return {
      kind: "register-provider",
      message: `No registered provider supports ${capabilityRef}; register a provider that does.`,
      providerIds: []
    };
  }

  return {
    kind: "provider-candidates",
    message: `Host on registered provider ${providerIds[0]}.`,
    providerIds
  };
}

function normalizeRequests(requests) {
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new Error("requests must be a non-empty array");
  }

  return requests.map((request, index) => {
    assertString(request?.port, `requests.${index}.port`);
    assertString(request?.feature, `requests.${index}.feature`);
    if (!STRICTNESS.has(request?.strictness)) {
      throw new Error(`requests.${index}.strictness must be require or prefer`);
    }
    return {
      port: request.port,
      feature: request.feature,
      strictness: request.strictness
    };
  });
}

function normalizeProviders(providers) {
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error("providers must be a non-empty array");
  }

  const byId = new Map();
  for (const [providerIndex, provider] of providers.entries()) {
    assertString(provider?.id, `providers.${providerIndex}.id`);
    if (!Array.isArray(provider.capabilities)) {
      throw new Error(`providers.${providerIndex}.capabilities must be an array`);
    }
    byId.set(provider.id, {
      id: provider.id,
      capabilities: provider.capabilities.map((capability, capabilityIndex) => {
        assertString(capability?.port, `providers.${providerIndex}.capabilities.${capabilityIndex}.port`);
        assertString(capability?.feature, `providers.${providerIndex}.capabilities.${capabilityIndex}.feature`);
        if (!STABILITY.has(capability?.stability)) {
          throw new Error(`providers.${providerIndex}.capabilities.${capabilityIndex}.stability must be one of ${[...STABILITY].join(", ")}`);
        }
        return {
          port: capability.port,
          feature: capability.feature,
          stability: capability.stability
        };
      }).sort((left, right) =>
        `${left.port}.${left.feature}.${left.stability}`.localeCompare(`${right.port}.${right.feature}.${right.stability}`)
      )
    });
  }

  return new Map([...byId.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function assertResource(resource) {
  if (!resource || !isJsonObject(resource) || Array.isArray(resource)) {
    throw new Error("resource must be an object");
  }
  assertString(resource.id, "resource.id");
  assertString(resource.type, "resource.type");
  assertString(resource.selectedProviderId, "resource.selectedProviderId");
}

function assertString(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function lowercaseFirst(value) {
  return `${value.slice(0, 1).toLowerCase()}${value.slice(1)}`;
}
