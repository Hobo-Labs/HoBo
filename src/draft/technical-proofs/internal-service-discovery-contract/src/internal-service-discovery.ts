import { isJsonString } from "./json.js";
import {
  MTLS_DATA_PATH_SCHEMA_VERSION,
  evaluateMtlsHandshake,
} from "../../mtls-data-path-contract/src/mtls-data-path.js";

const RESOURCE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export function createProviderEndpoint({ host, address, port }) {
  const normalizedPort = Number(port);
  if (!isNonEmptyString(host)) {
    throw new Error("provider endpoint host must be a non-empty string");
  }
  if (!isNonEmptyString(address)) {
    throw new Error("provider endpoint address must be a non-empty string");
  }
  if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
    throw new Error("provider endpoint port must be an integer from 1 to 65535");
  }

  return Object.freeze({
    host,
    address,
    port: normalizedPort,
  });
}

export function createInternalServiceDirectory({
  camp,
  tenant,
  bindle,
  trustDomain,
  mtlsEvaluator = evaluateMtlsHandshake,
}) {
  for (const [field, value] of Object.entries({ camp, tenant, bindle, trustDomain })) {
    if (!isNonEmptyString(value)) {
      throw new Error(`${field} must be a non-empty string`);
    }
  }
  if (!(mtlsEvaluator instanceof Function)) {
    throw new Error("mtlsEvaluator must be a function");
  }

  const resources = new Map();
  const bindings = new Map();

  return Object.freeze({
    registerResource(resource) {
      const normalized = normalizeResource({ resource, camp, tenant, bindle });
      resources.set(normalized.name, normalized);
      return publicBindingFor(normalized, { camp, tenant, bindle });
    },

    bind({ from, to, verbs }) {
      const fromResource = requireKnownResource(resources, bindle, from);
      const toResource = requireKnownResource(resources, bindle, to);
      const normalizedVerbs = normalizeVerbs(verbs);
      const key = bindKey(fromResource.name, toResource.name);
      const edge = Object.freeze({
        from: fromResource.name,
        to: toResource.name,
        verbs: normalizedVerbs,
        bindEdgeId: `${bindle}.${fromResource.name}->${bindle}.${toResource.name}`,
      });
      bindings.set(key, edge);
      return edge;
    },

    resolveBinding(name) {
      const resource = requireKnownResource(resources, bindle, name);
      return publicBindingFor(resource, { camp, tenant, bindle });
    },

    updateProviderEndpoint(name, endpoint) {
      const resource = requireKnownResource(resources, bindle, name);
      const normalizedEndpoint = createProviderEndpoint(endpoint);
      resources.set(resource.name, Object.freeze({
        ...resource,
        endpoint: normalizedEndpoint,
        endpointVersion: resource.endpointVersion + 1,
      }));
      return publicBindingFor(resources.get(resource.name), { camp, tenant, bindle });
    },

    inspectRuntimeEndpoint(name) {
      const resource = requireKnownResource(resources, bindle, name);
      return clone(resource.endpoint);
    },

    discoverPeer({ from, to, now }) {
      const source = resources.get(normalizeResourceName(from));
      if (!source) {
        return unknownResource(bindle, from);
      }

      const peerName = normalizeResourceName(to);
      const peer = resources.get(peerName);
      if (!peer) {
        return unknownResource(bindle, to);
      }

      if (!peer.svid) {
        return invalid(
          "internal-discovery.identity-required",
          `${peer.logicalName} has no SVID identity; public DNS fallback is forbidden`,
        );
      }

      const edge = bindings.get(bindKey(source.name, peer.name));
      if (!edge) {
        return invalid(
          "internal-discovery.unbound-peer",
          `${source.logicalName} is not bound to ${peer.logicalName}`,
        );
      }

      const handshake = mtlsEvaluator({
        schemaVersion: MTLS_DATA_PATH_SCHEMA_VERSION,
        connectionId: `internal-${source.name}-${peer.name}`,
        tenant,
        trustDomain,
        sourceSvid: source.svid,
        peerCertificate: {
          spiffeId: peer.svid,
          serialNumber: peer.certificateSerialNumber,
          notBefore: peer.certificateNotBefore,
          notAfter: peer.certificateNotAfter,
          rotationEpoch: peer.rotationEpoch,
        },
        allowedPeers: [peer.svid],
        certMaterialRef: `identity://svid-cert/${tenant}/${bindle}/${source.name}`,
        minimumPeerRotationEpoch: 0,
        authz: {
          bindEdgeId: edge.bindEdgeId,
          verbs: edge.verbs,
        },
        now,
      });

      if (!handshake.ok) {
        return handshake;
      }

      return {
        ok: true,
        discoveryPath: "svid-identity",
        transport: "mtls",
        providers: {
          from: source.provider,
          to: peer.provider,
        },
        peer: publicBindingFor(peer, { camp, tenant, bindle }),
        authz: handshake.authz,
      };
    },
  });
}

function normalizeResource({ resource, camp, tenant, bindle }) {
  const name = normalizeResourceName(resource.name);
  return Object.freeze({
    name,
    logicalName: `${bindle}.${name}`,
    provider: requireString(resource.provider, "provider"),
    region: requireString(resource.region, "region"),
    svid: resource.svid,
    endpoint: createProviderEndpoint(resource.endpoint),
    endpointVersion: 1,
    publicDnsRecords: Array.isArray(resource.publicDnsRecords)
      ? [...resource.publicDnsRecords]
      : [],
    certificateSerialNumber: resource.certificateSerialNumber ?? `stub-cert-${name}`,
    certificateNotBefore: resource.certificateNotBefore ?? "2026-06-28T11:55:00.000Z",
    certificateNotAfter: resource.certificateNotAfter ?? "2026-06-28T12:05:00.000Z",
    rotationEpoch: resource.rotationEpoch ?? 1,
    endpointRef: `internal-endpoint://${camp}/${bindle}/${name}`,
    identityRef: resource.svid ?? null,
    tenant,
  });
}

function publicBindingFor(resource, { camp, tenant }) {
  return {
    logicalName: resource.logicalName,
    camp,
    tenant,
    endpointRef: resource.endpointRef,
    identityRef: resource.identityRef,
  };
}

function requireKnownResource(resources, bindle, name) {
  const normalizedName = normalizeResourceName(name);
  const resource = resources.get(normalizedName);
  if (!resource) {
    throw new Error(`unknown logical resource ${bindle}.${normalizedName}`);
  }
  return resource;
}

function normalizeResourceName(name) {
  if (!isNonEmptyString(name)) {
    throw new Error("resource name must be a non-empty string");
  }
  const value = name.includes(".") ? name.split(".").at(-1) : name;
  if (!RESOURCE_NAME_PATTERN.test(value)) {
    throw new Error(`invalid resource name: ${name}`);
  }
  return value;
}

function normalizeVerbs(verbs) {
  if (!Array.isArray(verbs) || verbs.length === 0) {
    throw new Error("bind verbs must be a non-empty array");
  }
  return verbs.map((verb) => requireString(verb, "bind verb"));
}

function bindKey(from, to) {
  return `${from}->${to}`;
}

function unknownResource(bindle, name) {
  const resourceName = normalizeResourceName(name);
  return invalid(
    "internal-discovery.unknown-logical-name",
    `unknown logical resource ${bindle}.${resourceName}`,
  );
}

function invalid(code, reason) {
  return { ok: false, code, reason };
}

function requireString(value, field) {
  if (!isNonEmptyString(value)) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim() !== "";
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
