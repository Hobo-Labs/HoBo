import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const REGISTRY_DEPENDENCY_CONFUSION_GUARD_CONTRACT =
  "hobo.registry.dependency-confusion-guard/v1";

const SHA256_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

export async function resolvePinnedRegistryArtifact({
  pin,
  mirrors,
  selectedMirrorId,
} = {}) {
  const normalizedPin = normalizePin(pin);
  if (!Array.isArray(mirrors) || mirrors.length === 0) {
    throw new Error("mirrors must be a non-empty array");
  }

  const exactListings = [];
  const rejectedListings = [];

  for (const mirror of mirrors) {
    validateMirror(mirror);
    const listings = await mirror.list({
      name: normalizedPin.name,
      version: normalizedPin.version,
      digest: normalizedPin.digest,
    });
    if (!Array.isArray(listings)) {
      throw new Error(`${mirror.mirrorId}.list must return an array`);
    }

    for (const listing of listings) {
      const normalizedListing = normalizeListing({ listing, mirror });
      if (isExactPinnedCoordinate(normalizedPin, normalizedListing)) {
        exactListings.push(normalizedListing);
        continue;
      }

      const reason = shadowReason(normalizedPin, normalizedListing);
      if (reason) {
        rejectedListings.push(Object.freeze({
          ...stripListing(normalizedListing),
          reason,
        }));
      }
    }
  }

  if (exactListings.length === 0) {
    return failure({
      reason: "artifact.pinned_coordinate_absent",
      reasons: [
        `No mirror listed exact pinned coordinate ${coordinateKey(normalizedPin)} ${normalizedPin.digest}`,
      ],
      pin: normalizedPin,
      rejectedListings,
    });
  }

  const conflictingDigests = digestGroups(exactListings);
  if (conflictingDigests.length !== 1 || conflictingDigests[0].digest !== normalizedPin.digest) {
    return failure({
      reason: "artifact.digest_mismatch_across_mirrors",
      reasons: exactListings.map((listing) =>
        `${listing.mirrorId}: ${coordinateKey(listing)} listed ${listing.digest}, pinned ${normalizedPin.digest}`,
      ),
      pin: normalizedPin,
      exactListings,
      rejectedListings,
      conflictingDigests,
    });
  }

  const candidates = exactListings.map((listing) => costCandidateFrom(listing));
  const selectedListing = selectFetchCandidate({ exactListings, selectedMirrorId });

  if (!selectedListing) {
    return failure({
      reason: "artifact.selected_mirror_not_digest_eligible",
      reasons: [
        selectedMirrorId
          ? `${selectedMirrorId} is not digest-eligible for ${coordinateKey(normalizedPin)} ${normalizedPin.digest}`
          : `Multiple digest-identical mirrors are eligible; mirror ranking belongs to HOBO-374`,
      ],
      pin: normalizedPin,
      exactListings,
      rejectedListings,
      costEligibleMirrorIds: candidates.map((candidate) => candidate.mirrorId),
    });
  }

  const fetched = await selectedListing.mirror.fetch({
    name: selectedListing.name,
    version: selectedListing.version,
    digest: selectedListing.digest,
  });
  const fetchedBytes = toBuffer(fetched?.bytes ?? fetched, "fetched artifact bytes");
  const artifact = Object.freeze({
    bytes: Buffer.from(fetchedBytes),
    digest: sha256Digest(fetchedBytes),
  });
  const selection = Object.freeze({
    mirrorId: selectedListing.mirrorId,
    name: selectedListing.name,
    version: selectedListing.version,
    digest: selectedListing.digest,
    costMicros: selectedListing.costMicros,
    latencyMs: selectedListing.latencyMs,
  });

  if (artifact.digest !== normalizedPin.digest) {
    return failure({
      reason: "artifact.fetch_digest_mismatch",
      reasons: [`${selection.mirrorId}: fetched ${artifact.digest}, pinned ${normalizedPin.digest}`],
      pin: normalizedPin,
      exactListings,
      rejectedListings,
      costEligibleMirrorIds: candidates.map((candidate) => candidate.mirrorId),
      selection,
      artifact,
    });
  }

  return Object.freeze({
    ok: true,
    reasons: Object.freeze([]),
    contract: REGISTRY_DEPENDENCY_CONFUSION_GUARD_CONTRACT,
    pin: clone(normalizedPin),
    costEligibleMirrorIds: Object.freeze(candidates.map((candidate) => candidate.mirrorId)),
    conflictingDigests: Object.freeze(conflictingDigests.map(clone)),
    rejectedListings: Object.freeze(rejectedListings.map(clone)),
    selection,
    artifact,
    auditEvent: Object.freeze({
      type: "artifact.DependencyResolved",
      contract: REGISTRY_DEPENDENCY_CONFUSION_GUARD_CONTRACT,
      coordinate: coordinateKey(normalizedPin),
      digest: normalizedPin.digest,
      mirrorId: selection.mirrorId,
    }),
  });
}

export function createFixtureMirror({
  mirrorId,
  listings,
  costMicros = 0,
  latencyMs = 0,
  timeline,
} = {}) {
  if (!isNonEmptyString(mirrorId)) {
    throw new Error("mirrorId must be a non-empty string");
  }
  if (!Array.isArray(listings)) {
    throw new Error("listings must be an array");
  }

  const normalizedListings = listings.map((listing) => {
    const artifactBytes = toBuffer(listing.artifactBytes, "listing.artifactBytes");
    const fetchBytes = toBuffer(listing.fetchBytes ?? artifactBytes, "listing.fetchBytes");
    const digest = listing.digest ?? sha256Digest(artifactBytes);

    return Object.freeze({
      name: listing.name,
      version: listing.version,
      digest,
      fetchBytes,
    });
  });

  return Object.freeze({
    mirrorId,
    costMicros,
    latencyMs,
    async list() {
      pushTimeline(timeline, `list:${mirrorId}`);
      return normalizedListings.map((listing) => ({
        name: listing.name,
        version: listing.version,
        digest: listing.digest,
      }));
    },
    async fetch({ name, version, digest }) {
      pushTimeline(timeline, `fetch:${mirrorId}`);
      const listing = normalizedListings.find((candidate) =>
        candidate.name === name &&
        candidate.version === version &&
        candidate.digest === digest
      );
      if (!listing) {
        throw new Error(`${mirrorId}: listing not found for ${name}@${version} ${digest}`);
      }

      return Object.freeze({
        bytes: Buffer.from(listing.fetchBytes),
      });
    },
  });
}

export function sha256Digest(bytes) {
  return `sha256:${createHash("sha256").update(toBuffer(bytes, "bytes")).digest("hex")}`;
}

function toBuffer(value, path) {
  if (Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (isJsonString(value)) {
    return Buffer.from(value);
  }
  throw new Error(`${path} must be bytes`);
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
}

function pushTimeline(timeline, entry) {
  if (Array.isArray(timeline)) {
    timeline.push(entry);
  }
}

function validateMirror(mirror) {
  if (!mirror || !isJsonObject(mirror) || Array.isArray(mirror)) {
    throw new Error("mirror must be an object");
  }
  if (!isNonEmptyString(mirror.mirrorId)) {
    throw new Error("mirror.mirrorId must be a non-empty string");
  }
  if (!(mirror.list instanceof Function)) {
    throw new Error(`${mirror.mirrorId}.list must be a function`);
  }
  if (!(mirror.fetch instanceof Function)) {
    throw new Error(`${mirror.mirrorId}.fetch must be a function`);
  }
}

function normalizePin(pin) {
  if (!pin || !isJsonObject(pin) || Array.isArray(pin)) {
    throw new Error("pin must be an object");
  }
  if (!isNonEmptyString(pin.name)) {
    throw new Error("pin.name must be a non-empty string");
  }
  if (!isNonEmptyString(pin.version)) {
    throw new Error("pin.version must be a non-empty string");
  }
  if (!SHA256_DIGEST_RE.test(pin.digest)) {
    throw new Error("pin.digest must be sha256:<64 hex chars>");
  }

  return Object.freeze({
    name: pin.name,
    version: pin.version,
    digest: pin.digest,
  });
}

function normalizeListing({ listing, mirror }) {
  if (!listing || !isJsonObject(listing) || Array.isArray(listing)) {
    throw new Error(`${mirror.mirrorId}: listing must be an object`);
  }
  if (!isNonEmptyString(listing.name)) {
    throw new Error(`${mirror.mirrorId}: listing.name must be a non-empty string`);
  }
  if (!isNonEmptyString(listing.version)) {
    throw new Error(`${mirror.mirrorId}: listing.version must be a non-empty string`);
  }
  if (!SHA256_DIGEST_RE.test(listing.digest)) {
    throw new Error(`${mirror.mirrorId}: listing.digest must be sha256:<64 hex chars>`);
  }

  return Object.freeze({
    mirror,
    mirrorId: mirror.mirrorId,
    name: listing.name,
    version: listing.version,
    digest: listing.digest,
    costMicros: numberOrDefault(mirror.costMicros, 0),
    latencyMs: numberOrDefault(mirror.latencyMs, 0),
  });
}

function isExactPinnedCoordinate(pin, listing) {
  return listing.name === pin.name && listing.version === pin.version;
}

function shadowReason(pin, listing) {
  if (listing.name === pin.name && listing.version !== pin.version) {
    return "version-shadow";
  }
  if (packageStem(listing.name).includes(packageStem(pin.name)) ||
      packageStem(pin.name).includes(packageStem(listing.name))) {
    return "name-shadow";
  }
  return null;
}

function packageStem(name) {
  return String(name)
    .replace(/^@[^/]+\//, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function digestGroups(listings) {
  const groups = new Map();
  for (const listing of listings) {
    const mirrorIds = groups.get(listing.digest) ?? [];
    mirrorIds.push(listing.mirrorId);
    groups.set(listing.digest, mirrorIds);
  }

  return Object.freeze([...groups.entries()]
    .map(([digest, mirrorIds]) => Object.freeze({
      digest,
      mirrorIds: Object.freeze([...mirrorIds].sort()),
    }))
    .sort((left, right) => left.digest.localeCompare(right.digest)));
}

function costCandidateFrom(listing) {
  return Object.freeze({
    mirrorId: listing.mirrorId,
    name: listing.name,
    version: listing.version,
    digest: listing.digest,
    costMicros: listing.costMicros,
    latencyMs: listing.latencyMs,
  });
}

function selectFetchCandidate({ exactListings, selectedMirrorId }) {
  if (isNonEmptyString(selectedMirrorId)) {
    return exactListings.find((listing) => listing.mirrorId === selectedMirrorId) ?? null;
  }
  if (exactListings.length === 1) {
    return exactListings[0];
  }
  return null;
}

function failure({
  reason,
  reasons,
  pin,
  exactListings = [],
  rejectedListings = [],
  conflictingDigests = [],
  costEligibleMirrorIds = [],
  selection = null,
  artifact = null,
}) {
  return Object.freeze({
    ok: false,
    reason,
    reasons: Object.freeze([...new Set(reasons.length > 0 ? reasons : [reason])]),
    contract: REGISTRY_DEPENDENCY_CONFUSION_GUARD_CONTRACT,
    pin: clone(pin),
    costEligibleMirrorIds: Object.freeze(costEligibleMirrorIds),
    conflictingDigests: Object.freeze(conflictingDigests.map(clone)),
    rejectedListings: Object.freeze(rejectedListings.map(clone)),
    exactListings: Object.freeze(exactListings.map((listing) => clone(stripListing(listing)))),
    selection,
    artifact,
    auditEvent: Object.freeze({
      type: "artifact.DependencyResolveFailed",
      contract: REGISTRY_DEPENDENCY_CONFUSION_GUARD_CONTRACT,
      coordinate: coordinateKey(pin),
      digest: pin.digest,
      reason,
    }),
  });
}

function stripListing(listing) {
  return Object.freeze({
    mirrorId: listing.mirrorId,
    name: listing.name,
    version: listing.version,
    digest: listing.digest,
    costMicros: listing.costMicros,
    latencyMs: listing.latencyMs,
  });
}

function coordinateKey(coordinate) {
  return `${coordinate.name}@${coordinate.version}`;
}

function numberOrDefault(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
