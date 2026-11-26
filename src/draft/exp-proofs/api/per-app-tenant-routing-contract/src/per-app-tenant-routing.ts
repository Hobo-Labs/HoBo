import { isJsonString, isJsonObject } from "./json.js";
export const PER_APP_TENANT_ROUTING_CONTRACT_VERSION = "hobo.per-app-tenant-routing/v1";

export function createTenantRoutingTable(config) {
  assertObject(config, "routing config");
  const applicationDomain = normalizeHost(config.applicationDomain, "applicationDomain");
  const trustedGatewayHosts = Object.create(null);
  for (const host of [applicationDomain, ...(config.trustedGatewayHosts ?? [])]) {
    trustedGatewayHosts[normalizeHost(host, "trustedGatewayHost")] = true;
  }

  const tenantById = Object.create(null);
  const subdomainHosts = Object.create(null);
  const customDomainHosts = Object.create(null);
  const pathPrefixes = [];

  const tenants = (config.tenants ?? []).map((tenant) => {
    const normalized = normalizeTenant(tenant, applicationDomain);
    if (tenantById[normalized.id]) {
      throw new Error(`duplicate tenant ${normalized.id}`);
    }
    tenantById[normalized.id] = normalized;

    if (subdomainHosts[normalized.subdomainHost]) {
      throw new Error(`duplicate tenant subdomain ${normalized.subdomainHost}`);
    }
    subdomainHosts[normalized.subdomainHost] = normalized.id;

    if (normalized.pathPrefix) {
      pathPrefixes.push({ prefix: normalized.pathPrefix, tenantId: normalized.id });
    }

    for (const domain of normalized.customDomains) {
      if (customDomainHosts[domain.host]) {
        throw new Error(`duplicate custom domain ${domain.host}`);
      }
      customDomainHosts[domain.host] = {
        tenantId: normalized.id,
        domain,
      };
    }

    return normalized;
  });

  if (tenants.length === 0) {
    throw new Error("routing config requires at least one tenant");
  }

  pathPrefixes.sort((left, right) => right.prefix.length - left.prefix.length);

  return deepFreeze({
    version: PER_APP_TENANT_ROUTING_CONTRACT_VERSION,
    applicationDomain,
    trustedGatewayHosts,
    wildcardCertificates: (config.wildcardCertificates ?? []).map(normalizeCertificate),
    tenants,
    tenantById,
    subdomainHosts,
    customDomainHosts,
    pathPrefixes,
  });
}

export function routeTenantRequest(routingTable, request, handler = () => undefined) {
  const decision = resolveTenantRequest(routingTable, request);
  if (decision.effect !== "allow") {
    return decision;
  }

  return {
    ...decision,
    handlerResult: handler(decision.ctx),
  };
}

export function resolveTenantRequest(routingTable, request) {
  assertObject(routingTable, "routing table");
  assertObject(request, "request");

  const host = normalizeHost(request.host, "request.host");
  const path = normalizePath(request.path ?? "/");
  const hostResolution = resolveHost(routingTable, host);
  if (hostResolution.effect === "deny") {
    return deny(hostResolution.reason, { host });
  }

  let selected = hostResolution.selected;
  const pathResolution = resolvePath(routingTable, path);
  if (pathResolution.selected) {
    const reconciled = reconcileSelection(selected, pathResolution.selected, "tenant-path-mismatch");
    if (reconciled.effect === "deny") {
      return deny(reconciled.reason, { host, path });
    }
    selected = reconciled.selected;
  }

  const jwtResolution = resolveJwtClaim(routingTable, request.jwt);
  if (jwtResolution.effect === "deny") {
    return deny(jwtResolution.reason, { host, path });
  }
  if (jwtResolution.selected) {
    const reconciled = reconcileSelection(selected, jwtResolution.selected, "tenant-claim-mismatch");
    if (reconciled.effect === "deny") {
      return deny(reconciled.reason, { host, path });
    }
    selected = reconciled.selected;
  }

  if (!selected) {
    return deny("tenant-unresolved", { host, path });
  }

  const tenant = routingTable.tenantById[selected.tenantId];
  if (!tenant) {
    return deny("tenant-unknown", { host, path, tenantId: selected.tenantId });
  }

  const certificate = resolveCertificate(routingTable, host, selected);
  if (selected.source === "subdomain" && !certificate) {
    return deny("tenant-certificate-unavailable", { host, path, tenantId: tenant.id });
  }

  const domainResource = selected.domainResource ? clone(selected.domainResource) : undefined;
  const placement = clone(tenant.placement);
  const ctx = {
    tenant: {
      id: tenant.id,
      routeSource: selected.source,
    },
    placement,
    request: {
      host,
      path,
    },
  };

  return {
    effect: "allow",
    status: 200,
    resolvedBeforeHandler: true,
    resolvedBy: selected.source,
    ctx,
    placement,
    certificate,
    domainResource,
    forwardedPath: pathResolution.selected?.tenantId === tenant.id ? pathResolution.forwardedPath : path,
  };
}

function normalizeTenant(tenant, applicationDomain) {
  assertObject(tenant, "tenant");
  if (!isJsonString(tenant.id) || tenant.id.length === 0) {
    throw new Error("tenant requires a non-empty id");
  }

  const id = tenant.id.toLowerCase();
  const subdomain = normalizeLabel(tenant.subdomain ?? id, `tenant ${id} subdomain`);
  const pathPrefix = normalizePathPrefix(tenant.pathPrefix ?? `/t/${id}`);
  const placement = normalizePlacement(tenant.placement, id);

  return {
    id,
    subdomain,
    subdomainHost: `${subdomain}.${applicationDomain}`,
    pathPrefix,
    customDomains: (tenant.customDomains ?? []).map((domain) => normalizeCustomDomain(domain, id)),
    placement,
  };
}

function normalizeCustomDomain(domain, tenantId) {
  assertObject(domain, `custom domain for ${tenantId}`);
  const host = normalizeHost(domain.host, `custom domain for ${tenantId}`);
  if (domain.verified !== true) {
    throw new Error(`custom domain ${host} for ${tenantId} must be verified`);
  }
  if (domain.tenantScoped !== true) {
    throw new Error(`custom domain ${host} for ${tenantId} must be tenant scoped`);
  }
  if (!isJsonString(domain.resourceId) || domain.resourceId.length === 0) {
    throw new Error(`custom domain ${host} for ${tenantId} requires a resourceId`);
  }

  return {
    host,
    resourceId: domain.resourceId,
    certificateRef: domain.certificateRef,
    tenantScoped: true,
    verified: true,
  };
}

function normalizePlacement(placement, tenantId) {
  assertObject(placement, `placement for ${tenantId}`);
  if (!["pooled", "siloed", "region-pooled"].includes(placement.mode)) {
    throw new Error(`placement for ${tenantId} has unsupported mode ${placement.mode}`);
  }
  if (!isJsonString(placement.camp) || placement.camp.length === 0) {
    throw new Error(`placement for ${tenantId} requires a camp`);
  }
  if (!isJsonString(placement.region) || placement.region.length === 0) {
    throw new Error(`placement for ${tenantId} requires a region`);
  }

  return {
    mode: placement.mode,
    camp: placement.camp,
    region: placement.region,
  };
}

function normalizeCertificate(certificate) {
  assertObject(certificate, "wildcard certificate");
  if (!isJsonString(certificate.pattern) || !certificate.pattern.startsWith("*.")) {
    throw new Error("wildcard certificate requires a pattern like *.app.com");
  }
  if (certificate.status !== "issued") {
    throw new Error(`wildcard certificate ${certificate.pattern} must be issued`);
  }

  return {
    id: certificate.id,
    pattern: certificate.pattern.toLowerCase(),
    source: certificate.source,
    status: "issued",
  };
}

function resolveHost(routingTable, host) {
  const customDomain = routingTable.customDomainHosts[host];
  if (customDomain) {
    return {
      selected: {
        source: "custom-domain",
        tenantId: customDomain.tenantId,
        domainResource: customDomain.domain,
      },
    };
  }

  const subdomainTenantId = routingTable.subdomainHosts[host];
  if (subdomainTenantId) {
    return {
      selected: {
        source: "subdomain",
        tenantId: subdomainTenantId,
      },
    };
  }

  if (routingTable.trustedGatewayHosts[host]) {
    return {};
  }

  if (host.endsWith(`.${routingTable.applicationDomain}`)) {
    return {
      effect: "deny",
      reason: "tenant-host-unknown",
    };
  }

  return {
    effect: "deny",
    reason: "tenant-host-unknown",
  };
}

function resolvePath(routingTable, path) {
  for (const route of routingTable.pathPrefixes) {
    if (path === route.prefix || path.startsWith(`${route.prefix}/`)) {
      return {
        selected: {
          source: "path",
          tenantId: route.tenantId,
        },
        forwardedPath: path === route.prefix ? "/" : path.slice(route.prefix.length),
      };
    }
  }

  return {};
}

function resolveJwtClaim(routingTable, jwt) {
  if (jwt === undefined || jwt === null || jwt.tenant === undefined) {
    return {};
  }
  if (jwt.verified !== true) {
    return {
      effect: "deny",
      reason: "tenant-claim-unverified",
    };
  }

  const tenantId = String(jwt.tenant).toLowerCase();
  if (!routingTable.tenantById[tenantId]) {
    return {
      effect: "deny",
      reason: "tenant-claim-unknown",
    };
  }

  return {
    selected: {
      source: "jwt-claim",
      tenantId,
    },
  };
}

function reconcileSelection(existing, candidate, mismatchReason) {
  if (!existing) {
    return { selected: candidate };
  }
  if (existing.tenantId !== candidate.tenantId) {
    return {
      effect: "deny",
      reason: mismatchReason,
    };
  }

  return {
    selected: existing,
  };
}

function resolveCertificate(routingTable, host, selected) {
  if (selected.source === "custom-domain") {
    return selected.domainResource.certificateRef
      ? { certRef: selected.domainResource.certificateRef, source: "tenant-domain-resource" }
      : undefined;
  }

  if (selected.source !== "subdomain") {
    return undefined;
  }

  return routingTable.wildcardCertificates.find((certificate) => wildcardMatches(certificate.pattern, host));
}

function wildcardMatches(pattern, host) {
  const suffix = pattern.slice(1);
  if (!host.endsWith(suffix)) {
    return false;
  }
  const label = host.slice(0, -suffix.length);
  return label.length > 0 && !label.includes(".");
}

function deny(reason, extra = {}) {
  return {
    effect: "deny",
    status: reason === "tenant-host-unknown" ? 404 : 403,
    reason,
    resolvedBeforeHandler: true,
    ...extra,
  };
}

function normalizeHost(value, name) {
  if (!isJsonString(value) || value.trim().length === 0) {
    throw new Error(`${name} requires a non-empty host`);
  }

  let host = value.trim().toLowerCase();
  if (!host.includes("://")) {
    host = `https://${host}`;
  }

  try {
    const parsed = new URL(host);
    return parsed.hostname.replace(/\.$/, "");
  } catch {
    throw new Error(`${name} is not a valid host`);
  }
}

function normalizePath(value) {
  if (!isJsonString(value) || !value.startsWith("/")) {
    throw new Error(`request path must be absolute, got ${value}`);
  }
  return value;
}

function normalizePathPrefix(value) {
  const path = normalizePath(value);
  return path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
}

function normalizeLabel(value, name) {
  if (!isJsonString(value) || !/^[a-z0-9-]+$/i.test(value)) {
    throw new Error(`${name} must be a DNS label`);
  }
  return value.toLowerCase();
}

function assertObject(value, name) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return value;
}
