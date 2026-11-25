import { isJsonString } from "./json.js";
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export class WireVersionIncompatibleError extends Error {
  constructor({ reason, componentId, providerId, interfaceId, floor, callerVersions, providerVersions, sharedVersions }) {
    super(`wrpc.version_incompatible: ${reason}`);
    this.name = "WireVersionIncompatibleError";
    this.code = "version-incompatible";
    this.phase = "link-establishment";
    this.reason = reason;
    this.componentId = componentId;
    this.providerId = providerId;
    this.interfaceId = interfaceId;
    this.floor = floor;
    this.callerVersions = callerVersions;
    this.providerVersions = providerVersions;
    this.sharedVersions = sharedVersions;
  }
}

export function createWireVersionLinker({ compatibilityFloor }) {
  return new WireVersionLinker({ compatibilityFloor });
}

class WireVersionLinker {
  #components = new Map();
  #providers = new Map();
  #links = new Map();

  constructor({ compatibilityFloor }) {
    this.compatibilityFloor = normalizeVersion(compatibilityFloor);
    this.events = [];
  }

  registerComponent(component) {
    assertId(component?.id, "component");
    this.#components.set(component.id, {
      id: component.id,
      imports: indexInterfacePins(component.imports ?? [])
    });
  }

  registerProvider(provider) {
    assertId(provider?.id, "provider");
    this.#providers.set(provider.id, {
      id: provider.id,
      exports: indexInterfacePins(provider.exports ?? []),
      handlers: provider.handlers ?? {}
    });
  }

  establishLink({ componentId, importInterface, providerId, exportInterface }) {
    const component = this.#requireComponent(componentId);
    const provider = this.#requireProvider(providerId);
    const imported = component.imports.get(importInterface);
    const exported = provider.exports.get(exportInterface);
    if (!imported) throw new Error(`wrpc.import_not_declared: ${componentId}:${importInterface}`);
    if (!exported) throw new Error(`wrpc.export_not_found: ${providerId}:${exportInterface}`);

    const negotiatedWire = this.#negotiate({
      componentId,
      providerId,
      interfaceId: importInterface,
      caller: imported,
      provider: exported
    });
    const link = Object.freeze({
      componentId,
      importInterface,
      providerId,
      exportInterface,
      transport: "wrpc",
      phase: "link-establishment",
      negotiatedWire
    });
    this.#links.set(linkKey(componentId, importInterface), link);
    this.events.push({
      type: "link.Established",
      ...link
    });
    return link;
  }

  callImport(componentId, importInterface, operation, payload = {}) {
    const link = this.#links.get(linkKey(componentId, importInterface));
    if (!link) throw new Error(`wrpc.no_route: ${componentId}:${importInterface}`);

    const provider = this.#requireProvider(link.providerId);
    const handler = provider.handlers?.[link.exportInterface]?.[operation];
    if (!(handler instanceof Function)) {
      throw new Error(`wrpc.operation_not_found: ${link.exportInterface}.${operation}`);
    }
    return handler(payload, link);
  }

  manifestIr() {
    return {
      schema: "hobo.manifest.wrpc-links/v1",
      links: [...this.#links.values()].map((link) => ({
        componentId: link.componentId,
        importInterface: link.importInterface,
        providerId: link.providerId,
        exportInterface: link.exportInterface,
        wire: { ...link.negotiatedWire }
      }))
    };
  }

  report() {
    return {
      schema: "hobo.wrpc.wire-version-negotiation/v1",
      issue: "HOBO-26",
      compatibilityFloor: this.compatibilityFloor.raw,
      events: ["link.Established", "link.Rejected"],
      errors: ["version-incompatible"],
      scopeIn: [
        "highest shared minor negotiation at link establishment",
        "below-floor link rejection with a typed version-incompatible error",
        "negotiated minor recorded in link.Established and manifest IR",
        "mismatch rejected before any provider call can be made"
      ],
      scopeOut: [
        "compatibility floor policy selection",
        "preview or experimental upcasters",
        "NATS/JetStream lattice transport details",
        "deadline, backpressure, or partial-failure handling"
      ]
    };
  }

  #negotiate({ componentId, providerId, interfaceId, caller, provider }) {
    const floor = this.compatibilityFloor;
    const shared = sharedMinorCandidates(caller.versions, provider.versions)
      .sort(compareCandidatesDescending);
    const usable = shared.filter((candidate) => compareVersions(candidate.version, floor) >= 0);
    if (usable.length > 0) {
      const selected = usable[0];
      return Object.freeze({
        interfaceId,
        version: selected.version.raw,
        minor: `${selected.version.major}.${selected.version.minor}`,
        stability: caller.stability,
        floor: floor.raw
      });
    }

    const error = new WireVersionIncompatibleError({
      reason: shared.length === 0 ? "no-shared-minor" : "shared-minor-below-floor",
      componentId,
      providerId,
      interfaceId,
      floor: floor.raw,
      callerVersions: caller.versions.map((version) => version.raw),
      providerVersions: provider.versions.map((version) => version.raw),
      sharedVersions: shared.map((candidate) => candidate.version.raw)
    });
    this.events.push({
      type: "link.Rejected",
      code: error.code,
      reason: error.reason,
      componentId,
      providerId,
      interfaceId,
      floor: floor.raw
    });
    throw error;
  }

  #requireComponent(componentId) {
    const component = this.#components.get(componentId);
    if (!component) throw new Error(`wrpc.component_not_registered: ${componentId}`);
    return component;
  }

  #requireProvider(providerId) {
    const provider = this.#providers.get(providerId);
    if (!provider) throw new Error(`wrpc.provider_not_registered: ${providerId}`);
    return provider;
  }
}

function indexInterfacePins(pins) {
  const indexed = new Map();
  for (const pin of pins) {
    const interfaceId = pin?.interfaceId;
    assertId(interfaceId, "interface");
    indexed.set(interfaceId, {
      interfaceId,
      stability: pin.stability ?? "stable",
      versions: (pin.versions ?? []).map(normalizeVersion)
    });
  }
  return indexed;
}

function sharedMinorCandidates(callerVersions, providerVersions) {
  const candidates = [];
  for (const callerVersion of callerVersions) {
    for (const providerVersion of providerVersions) {
      if (callerVersion.major !== providerVersion.major || callerVersion.minor !== providerVersion.minor) {
        continue;
      }
      candidates.push({
        version: compareVersions(callerVersion, providerVersion) <= 0 ? callerVersion : providerVersion
      });
    }
  }
  return dedupeVersions(candidates);
}

function dedupeVersions(candidates) {
  const byRaw = new Map();
  for (const candidate of candidates) {
    byRaw.set(candidate.version.raw, candidate);
  }
  return [...byRaw.values()];
}

function normalizeVersion(version) {
  if (!isJsonString(version) || !SEMVER_RE.test(version)) {
    throw new Error(`wrpc.invalid_semver: ${String(version)}`);
  }
  const [core] = version.split(/[+-]/, 1);
  const [major, minor, patch] = core.split(".").map(Number);
  return Object.freeze({ raw: version, major, minor, patch });
}

function compareCandidatesDescending(left, right) {
  return compareVersions(right.version, left.version);
}

function compareVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  return 0;
}

function linkKey(componentId, importInterface) {
  return `${componentId}\0${importInterface}`;
}

function assertId(id, kind) {
  if (!isJsonString(id) || id.length === 0) {
    throw new Error(`wrpc.${kind}_id_required`);
  }
}
