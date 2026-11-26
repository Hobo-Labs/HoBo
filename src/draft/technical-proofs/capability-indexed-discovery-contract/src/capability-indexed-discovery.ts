import { createHash } from "node:crypto";

import {
  createFixtureCapabilitySpec,
  parseCapabilitySpec,
} from "../../capability-spec-contract/src/capability-spec.js";
import { isJsonString, isJsonObject } from "./json.js";


export const CAPABILITY_DISCOVERY_CONTRACT = "hobo.capability-discovery/v1";
export const DISCOVERY_MCP_TOOL_NAME = "hobo_find_capability_listings";

const DEFAULT_MATCHING = Object.freeze({
  regions: ["us-east-1"],
  classifications: ["public"],
});

const STABILITY_RANK = Object.freeze({
  stable: 4,
  preview: 3,
  experimental: 2,
  deprecated: 1,
});

export function createCapabilityDiscoveryIndex() {
  const listingsById = new Map();

  return Object.freeze({
    apply(event) {
      if (!isPlainObject(event) || !isNonEmptyString(event.type)) {
        return { applied: false, reason: "event must include type" };
      }

      if (event.type === "listing.Yanked") {
        if (!isNonEmptyString(event.listingId)) {
          return { applied: false, reason: "listing.Yanked requires listingId" };
        }
        const removed = listingsById.delete(event.listingId);
        return { applied: removed, listingId: event.listingId };
      }

      if (event.type !== "listing.Certified") {
        return { applied: false, reason: "event is not a discovery index lifecycle event" };
      }

      if (event.certification?.status !== "passed") {
        return { applied: false, reason: "listing.Certified requires passed certification" };
      }

      const normalized = normalizeCertifiedListing(event);
      if (!normalized.ok) {
        return { applied: false, reason: normalized.reason };
      }

      listingsById.set(normalized.listing.listingId, normalized.listing);
      return { applied: true, listingId: normalized.listing.listingId };
    },

    find(query) {
      const parsed = normalizeQuery(query);
      const matches = [...listingsById.values()]
        .flatMap((listing) => matchingCapabilities(listing, parsed))
        .sort(compareDiscoveryResults)
        .map((result, index) => ({ ...result, rank: index + 1 }));

      return {
        ok: true,
        contract: CAPABILITY_DISCOVERY_CONTRACT,
        query: parsed.publicQuery,
        results: matches,
        remediation: matches.length === 0 ? remediationFor(parsed) : undefined,
      };
    },

    entries() {
      return [...listingsById.values()].map(clone);
    },
  });
}

export function createDiscoveryMcpTool(index) {
  if (!index || !(index.find instanceof Function)) {
    throw new Error("discovery MCP tool requires an index with find(query)");
  }

  return Object.freeze({
    name: DISCOVERY_MCP_TOOL_NAME,
    async invoke(input) {
      return index.find(input);
    },
  });
}

export function createFixtureCertifiedListing({
  listingId = "listing-acme-blobstore",
  kind = "provider",
  name = "@acme/blobstore-provider",
  version = "1.0.0",
  providerId = "acme-blobstore",
  providerName = "@acme/blobstore",
  providerVersion = "1.0.0",
  interfaces = [
    {
      interface: "wasi:blobstore/blobstore",
      semver: "1.0.0",
      stability: "stable",
    },
  ],
  matching = DEFAULT_MATCHING,
} = {}) {
  const capabilitySpec = createFixtureCapabilitySpec({
    providerId,
    providerName,
    providerVersion,
    interfaces: interfaces.map((capability) => ({
      interface: capability.interface,
      semver: capability.semver,
      stability: capability.stability,
      suite: capability.suite ?? `@hobo/conformance/${capability.interface.split("/").at(-1)}`,
      suiteVersion: capability.suiteVersion ?? capability.semver,
    })),
  });

  return {
    schema: CAPABILITY_DISCOVERY_CONTRACT,
    listingId,
    kind,
    name,
    version,
    artifact: artifactRef(`${listingId}-${version}`),
    provider: {
      id: providerId,
      name: providerName,
      version: providerVersion,
    },
    capabilitySpec,
    matching: normalizeMatching(matching),
  };
}

function normalizeCertifiedListing(event) {
  const descriptor = event.descriptor;
  if (!isPlainObject(descriptor)) {
    return { ok: false, reason: "listing.Certified requires descriptor" };
  }

  const listingId = event.listingId ?? descriptor.listingId;
  if (!isNonEmptyString(listingId)) {
    return { ok: false, reason: "certified listing requires listingId" };
  }

  const parsedSpec = parseCapabilitySpec(descriptor.capabilitySpec);
  if (!parsedSpec.ok) {
    return {
      ok: false,
      reason: `capability spec invalid: ${parsedSpec.errors[0]}`,
    };
  }

  const provider = parsedSpec.spec.provider;
  const listing = {
    listingId,
    kind: descriptor.kind ?? "provider",
    name: descriptor.name ?? provider.name,
    version: descriptor.version ?? provider.version,
    digest: descriptor.artifact?.digest ?? digestOf(listingId),
    providerId: provider.id,
    providerName: provider.name,
    providerVersion: provider.version,
    capabilities: parsedSpec.spec.interfaces.map((capability) => ({
      interface: capability.interface,
      semver: capability.semver,
      stability: capability.stability,
      conformanceSuiteVersion: capability.conformanceSuiteVersion,
    })),
    matching: normalizeMatching(descriptor.matching),
    certifiedAt: event.occurredAt ?? null,
  };

  if (listing.capabilities.length === 0) {
    return { ok: false, reason: "certified listing declares no capabilities" };
  }

  return { ok: true, listing };
}

function matchingCapabilities(listing, parsed) {
  if (parsed.criteria.region && !listing.matching.regions.includes(parsed.criteria.region)) {
    return [];
  }
  if (
    parsed.criteria.classification &&
    !listing.matching.classifications.includes(parsed.criteria.classification)
  ) {
    return [];
  }
  if (parsed.criteria.kind && parsed.criteria.kind !== listing.kind) {
    return [];
  }

  return listing.capabilities
    .filter((capability) =>
      capability.interface === parsed.port.interface &&
      capability.semver === parsed.port.semver &&
      (!parsed.port.stability || capability.stability === parsed.port.stability)
    )
    .map((capability) => ({
      listingId: listing.listingId,
      kind: listing.kind,
      name: listing.name,
      version: listing.version,
      digest: listing.digest,
      providerId: listing.providerId,
      providerName: listing.providerName,
      providerVersion: listing.providerVersion,
      capability,
      matching: clone(listing.matching),
      certifiedAt: listing.certifiedAt,
    }));
}

function normalizeQuery(query) {
  if (!isPlainObject(query)) {
    throw new Error("discovery query must be an object");
  }

  const port = parsePortRef(query.port);
  if (!port) {
    throw new Error("query.port must be interface@semver or interface@semver@stability");
  }

  const criteria = normalizeCriteria(query.criteria);
  return {
    port,
    criteria,
    publicQuery: {
      port: query.port,
      criteria,
    },
  };
}

function normalizeCriteria(criteria) {
  if (criteria === undefined) {
    return {};
  }
  if (!isPlainObject(criteria)) {
    throw new Error("query.criteria must be an object");
  }

  const normalized = {};
  for (const field of ["region", "classification", "kind"]) {
    if (criteria[field] !== undefined) {
      normalized[field] = requireString(criteria[field], `criteria.${field}`);
    }
  }
  return normalized;
}

function parsePortRef(ref) {
  if (!isNonEmptyString(ref)) {
    return null;
  }

  const parts = ref.split("@");
  if (parts.length !== 2 && parts.length !== 3) {
    return null;
  }

  const [interfaceName, semver, stability] = parts;
  if (!/^[a-z][a-z0-9-]*:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(interfaceName)) {
    return null;
  }
  if (!isSemver(semver)) {
    return null;
  }
  if (stability !== undefined && !(stability in STABILITY_RANK)) {
    return null;
  }

  return { interface: interfaceName, semver, stability };
}

function compareDiscoveryResults(left, right) {
  const byStability = STABILITY_RANK[right.capability.stability] - STABILITY_RANK[left.capability.stability];
  if (byStability !== 0) return byStability;

  const byName = left.name.localeCompare(right.name);
  if (byName !== 0) return byName;

  const byVersion = left.version.localeCompare(right.version);
  if (byVersion !== 0) return byVersion;

  return left.listingId.localeCompare(right.listingId);
}

function remediationFor(parsed) {
  const criteria = [];
  if (parsed.criteria.region) criteria.push(`region=${parsed.criteria.region}`);
  if (parsed.criteria.classification) criteria.push(`classification=${parsed.criteria.classification}`);
  if (parsed.criteria.kind) criteria.push(`kind=${parsed.criteria.kind}`);
  const suffix = criteria.length > 0 ? ` matching ${criteria.join(", ")}` : "";

  return `No certified listing implements ${parsed.publicQuery.port}${suffix}. Publish a listing.Certified event for a Capability Spec that declares the interface, or generate a conformance-certified adapter.`;
}

function normalizeMatching(matching = DEFAULT_MATCHING) {
  const candidate = isPlainObject(matching) ? matching : {};
  return {
    regions: uniqueStrings(candidate.regions),
    classifications: uniqueStrings(candidate.classifications),
  };
}

function uniqueStrings(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return [...new Set(values.filter(isNonEmptyString))].sort();
}

function artifactRef(seed) {
  const digest = digestOf(seed);
  return {
    mediaType: "application/vnd.hobo.registry.listing.layer.v1+json",
    uri: `oci://registry.example/hobo/${sanitizeSeed(seed)}@${digest}`,
    digest,
  };
}

function digestOf(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sanitizeSeed(seed) {
  return String(seed).replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function requireString(value, field) {
  if (!isNonEmptyString(value)) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function isSemver(value) {
  return isJsonString(value) && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.test(value);
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
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
  return JSON.parse(JSON.stringify(value));
}
