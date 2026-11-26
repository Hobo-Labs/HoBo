import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const PORTABILITY_SWAP_EQUIVALENT_CONTRACT = "hobo.portability-swap-equivalent/v1";

const DEFAULT_INTERFACE_REF = "hobo:component-host/host@1.0.0@stable";
const DEFAULT_CONFORMANCE_SUITE = "@hobo/conformance/component-host";
const DEFAULT_CONFORMANCE_SUITE_VERSION = "1.0.0";

export function createPortabilitySwapRegistry(initialListings = []) {
  const listingsById = new Map();

  for (const listing of initialListings) {
    listingsById.set(listing.listingId, normalizeListing(listing));
  }

  return Object.freeze({
    swapForEquivalent({ bindle, fromListingId, toListingId } = {}) {
      const source = listingsById.get(fromListingId);
      if (!source) {
        return refused({ bindle, reasons: ["source.not_found"] });
      }

      const candidate = toListingId
        ? listingsById.get(toListingId)
        : [...listingsById.values()].find((listing) =>
            listing.listingId !== source.listingId &&
            isEquivalent(source, listing) &&
            listing.certification.status === "passed"
          );

      if (!candidate) {
        return generationRequired({ bindle, source });
      }

      const reasons = swapRefusalReasons({ source, candidate });
      if (reasons.length > 0) {
        return refused({ bindle, reasons });
      }

      return Object.freeze({
        ok: true,
        contract: PORTABILITY_SWAP_EQUIVALENT_CONTRACT,
        status: "Swapped",
        reasons: Object.freeze([]),
        gatesChecked: Object.freeze(["interface", "conformance"]),
        tierGateApplied: false,
        bindle: replaceDependency({ bindle, fromListingId, target: candidate }),
      });
    },

    exportListing(listingId, _options = {}) {
      const listing = listingsById.get(listingId);
      if (!listing) {
        return Object.freeze({
          ok: false,
          contract: PORTABILITY_SWAP_EQUIVALENT_CONTRACT,
          reasons: Object.freeze(["listing.not_found"]),
          gatedByTier: false,
          listing: null,
        });
      }

      return Object.freeze({
        ok: true,
        contract: PORTABILITY_SWAP_EQUIVALENT_CONTRACT,
        reasons: Object.freeze([]),
        gatedByTier: false,
        listing: clone(listing),
      });
    },

    importListing(listing, _options = {}) {
      const normalized = normalizeListing(listing);
      listingsById.set(normalized.listingId, normalized);
      return Object.freeze({
        ok: true,
        contract: PORTABILITY_SWAP_EQUIVALENT_CONTRACT,
        reasons: Object.freeze([]),
        gatedByTier: false,
        listing: clone(normalized),
      });
    },

    listings() {
      return [...listingsById.values()].map(clone);
    },
  });
}

export function createPortableBindle({
  bindleId = "bindle-checkout",
  appSourceDigest = digestOf("src/index.ts\nexport const handler = checkout;\n"),
  dependency,
} = {}) {
  const listing = normalizeListing(dependency ?? createFixtureListing());
  return deepFreeze({
    bindleId,
    appSourceDigest,
    dependencies: [
      dependencyPin(listing),
    ],
  });
}

export function createFixtureListing({
  listingId = "listing-component-host-a",
  kind = "provider",
  name = "@acme/component-host",
  version = "1.0.0",
  artifactDigest,
  interfaces = [interfaceDeclaration()],
  trustTier = "community",
  commercialTier = "none",
  certification,
} = {}) {
  const normalizedCertification = certification ?? {
    status: "passed",
    suite: DEFAULT_CONFORMANCE_SUITE,
    suiteVersion: DEFAULT_CONFORMANCE_SUITE_VERSION,
  };

  return normalizeListing({
    listingId,
    kind,
    name,
    version,
    artifactDigest: artifactDigest ?? digestOf(`${name}@${version}:${listingId}`),
    interfaces,
    trustTier,
    commercialTier,
    certification: normalizedCertification,
  });
}

function normalizeListing(listing) {
  if (!listing || !isJsonObject(listing) || Array.isArray(listing)) {
    throw new Error("listing must be an object");
  }
  const listingId = requireString(listing.listingId, "listing.listingId");
  const interfaces = (listing.interfaces ?? []).map(normalizeInterfaceDeclaration);
  if (interfaces.length === 0) {
    throw new Error("listing.interfaces must declare at least one interface");
  }

  return deepFreeze({
    listingId,
    kind: requireString(listing.kind ?? "provider", "listing.kind"),
    name: requireString(listing.name, "listing.name"),
    version: requireString(listing.version, "listing.version"),
    artifactDigest: requireString(listing.artifactDigest ?? digestOf(listingId), "listing.artifactDigest"),
    interfaces,
    trustTier: listing.trustTier ?? "community",
    commercialTier: listing.commercialTier ?? "none",
    certification: normalizeCertification(listing.certification, interfaces[0]),
  });
}

function normalizeInterfaceDeclaration(declaration) {
  const candidate = isJsonString(declaration) ? { ref: declaration } : declaration;
  if (!candidate || !isJsonObject(candidate) || Array.isArray(candidate)) {
    throw new Error("interface declaration must be a ref string or object");
  }
  const ref = requireString(candidate.ref, "interface.ref");
  return deepFreeze({
    ref,
    interface: parseInterfaceRef(ref),
    conformanceSuite: candidate.conformanceSuite ?? DEFAULT_CONFORMANCE_SUITE,
    conformanceSuiteVersion: candidate.conformanceSuiteVersion ?? DEFAULT_CONFORMANCE_SUITE_VERSION,
  });
}

function normalizeCertification(certification, interfaceDecl) {
  const candidate = certification ?? {};
  return deepFreeze({
    status: candidate.status ?? "missing",
    suite: candidate.suite ?? interfaceDecl.conformanceSuite,
    suiteVersion: candidate.suiteVersion ?? interfaceDecl.conformanceSuiteVersion,
  });
}

function interfaceDeclaration({
  ref = DEFAULT_INTERFACE_REF,
  conformanceSuite = DEFAULT_CONFORMANCE_SUITE,
  conformanceSuiteVersion = DEFAULT_CONFORMANCE_SUITE_VERSION,
} = {}) {
  return { ref, conformanceSuite, conformanceSuiteVersion };
}

function swapRefusalReasons({ source, candidate }) {
  const reasons = [];
  if (!isEquivalent(source, candidate)) {
    reasons.push("candidate.not_equivalent");
  }
  if (candidate.certification.status !== "passed") {
    reasons.push("candidate.conformance_failed");
  }
  if (!usesSameConformanceSuite(source, candidate)) {
    reasons.push("candidate.conformance_suite_mismatch");
  }
  return Object.freeze([...new Set(reasons)]);
}

function isEquivalent(source, candidate) {
  const sourceInterface = source.interfaces[0];
  const candidateInterface = candidate.interfaces.find((entry) =>
    sameInterfaceVersion(sourceInterface.interface, entry.interface)
  );
  return Boolean(candidateInterface && usesSameConformanceSuite(source, { ...candidate, interfaces: [candidateInterface] }));
}

function usesSameConformanceSuite(source, candidate) {
  const sourceInterface = source.interfaces[0];
  const candidateInterface = candidate.interfaces[0];
  return (
    candidate.certification.suite === sourceInterface.conformanceSuite &&
    candidate.certification.suiteVersion === sourceInterface.conformanceSuiteVersion &&
    candidateInterface.conformanceSuite === sourceInterface.conformanceSuite &&
    candidateInterface.conformanceSuiteVersion === sourceInterface.conformanceSuiteVersion
  );
}

function sameInterfaceVersion(left, right) {
  return left.name === right.name && left.version === right.version;
}

function generationRequired({ bindle, source }) {
  const sourceInterface = source.interfaces[0];
  return Object.freeze({
    ok: true,
    contract: PORTABILITY_SWAP_EQUIVALENT_CONTRACT,
    status: "GenerationRequired",
    reasons: Object.freeze([]),
    gatesChecked: Object.freeze(["interface", "conformance"]),
    tierGateApplied: false,
    bindle: clone(bindle),
    generationRequest: Object.freeze({
      reason: "no-listed-conformance-equivalent",
      interfaceRef: sourceInterface.ref,
      requiredSuite: `${sourceInterface.conformanceSuite}@${sourceInterface.conformanceSuiteVersion}`,
      sourceListingId: source.listingId,
    }),
  });
}

function refused({ bindle, reasons }) {
  return Object.freeze({
    ok: false,
    contract: PORTABILITY_SWAP_EQUIVALENT_CONTRACT,
    status: "Refused",
    reasons: Object.freeze(reasons),
    gatesChecked: Object.freeze(["interface", "conformance"]),
    tierGateApplied: false,
    bindle: clone(bindle),
  });
}

function replaceDependency({ bindle, fromListingId, target }) {
  const updated = {
    ...clone(bindle),
    dependencies: bindle.dependencies.map((dependency) =>
      dependency.listingId === fromListingId
        ? dependencyPin(target)
        : clone(dependency)
    ),
  };
  return deepFreeze(updated);
}

function dependencyPin(listing) {
  const iface = listing.interfaces[0];
  return deepFreeze({
    listingId: listing.listingId,
    name: listing.name,
    version: listing.version,
    artifactDigest: listing.artifactDigest,
    interfaceRef: iface.ref,
    conformanceSuite: iface.conformanceSuite,
    conformanceSuiteVersion: iface.conformanceSuiteVersion,
  });
}

function parseInterfaceRef(ref) {
  const match = /^([a-z][a-z0-9-]*:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?)@(stable|preview|experimental|deprecated)$/.exec(ref);
  if (!match) {
    throw new Error(`interface ref must be interface@semver@stability: ${ref}`);
  }
  return Object.freeze({
    name: match[1],
    version: match[2],
    stability: match[3],
  });
}

function requireString(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function digestOf(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}
