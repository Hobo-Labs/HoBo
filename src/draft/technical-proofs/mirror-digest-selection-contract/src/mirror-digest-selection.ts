import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const MIRROR_DIGEST_SELECTION_CONTRACT = "hobo.mirror-digest-selection/v1";

const SHA256_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

export async function selectDigestPinnedMirror({
  coordinate,
  resolvedDigest,
  mirrors,
  dispatchCostTiebreak = defaultDispatchCostTiebreak,
} = {}) {
  const normalizedCoordinate = normalizeCoordinate(coordinate);
  if (!SHA256_DIGEST_RE.test(resolvedDigest)) {
    throw new Error("resolvedDigest must be sha256:<64 hex chars>");
  }
  if (!Array.isArray(mirrors) || mirrors.length === 0) {
    throw new Error("mirrors must be a non-empty array");
  }
  if (!(dispatchCostTiebreak instanceof Function)) {
    throw new Error("dispatchCostTiebreak must be a function");
  }

  const verifications = [];
  for (const mirror of mirrors) {
    verifications.push(await verifyMirror({ mirror, coordinate: normalizedCoordinate, resolvedDigest }));
  }

  const unverified = verifications.filter((verification) => !verification.ok);
  if (unverified.length > 0) {
    return failure({
      reason: "mirror.unverified",
      reasons: unverified.flatMap((verification) => verification.reasons),
      coordinate: normalizedCoordinate,
      resolvedDigest,
      verifications,
    });
  }

  const mismatches = verifications.filter((verification) => verification.digest !== resolvedDigest);
  if (mismatches.length > 0) {
    return failure({
      reason: "mirror.digest_mismatch",
      reasons: mismatches.map(
        (verification) => `${verification.mirrorId}: verified ${verification.digest}, expected ${resolvedDigest}`,
      ),
      coordinate: normalizedCoordinate,
      resolvedDigest,
      verifications,
      escalatedTo: "HOBO-391",
    });
  }

  const candidates = verifications.map((verification) => costCandidateFrom(verification));
  const selectedMirrorId = await dispatchCostTiebreak({
    contract: MIRROR_DIGEST_SELECTION_CONTRACT,
    coordinate: clone(normalizedCoordinate),
    resolvedDigest,
    candidates: candidates.map(clone),
  });
  const selectedVerification = verifications.find((verification) => verification.mirrorId === selectedMirrorId);

  if (!selectedVerification) {
    return failure({
      reason: "dispatcher.invalid_selection",
      reasons: [`Dispatcher selected ${String(selectedMirrorId)}, which was not a verified mirror candidate`],
      coordinate: normalizedCoordinate,
      resolvedDigest,
      verifications,
      costEligibleMirrorIds: candidates.map((candidate) => candidate.mirrorId),
    });
  }

  const selection = selectionFrom(selectedVerification);
  const fetchedArtifact = await selectedVerification.mirror.fetch({
    coordinate: clone(normalizedCoordinate),
    digest: resolvedDigest,
    verificationRef: selectedVerification.verificationRef,
  });
  const artifactBytes = toBuffer(fetchedArtifact?.bytes ?? fetchedArtifact, "fetched artifact bytes");
  const artifactDigest = sha256Digest(artifactBytes);
  const artifact = Object.freeze({
    bytes: Buffer.from(artifactBytes),
    digest: artifactDigest,
  });

  if (artifactDigest !== resolvedDigest) {
    return failure({
      reason: "mirror.fetch_digest_mismatch",
      reasons: [`${selection.mirrorId}: fetched ${artifactDigest}, expected ${resolvedDigest}`],
      coordinate: normalizedCoordinate,
      resolvedDigest,
      verifications,
      costEligibleMirrorIds: candidates.map((candidate) => candidate.mirrorId),
      selection,
      artifact,
    });
  }

  return Object.freeze({
    ok: true,
    reasons: Object.freeze([]),
    contract: MIRROR_DIGEST_SELECTION_CONTRACT,
    coordinate: clone(normalizedCoordinate),
    resolvedDigest,
    costEligibleMirrorIds: Object.freeze(candidates.map((candidate) => candidate.mirrorId)),
    selection,
    artifact,
    auditEvent: Object.freeze({
      type: "artifact.MirrorSelected",
      contract: MIRROR_DIGEST_SELECTION_CONTRACT,
      coordinate: coordinateKey(normalizedCoordinate),
      digest: resolvedDigest,
      mirrorId: selection.mirrorId,
    }),
    verifications: Object.freeze(verifications.map(stripMirror)),
  });
}

export function defaultDispatchCostTiebreak({ candidates }) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("Dispatcher requires at least one verified digest-identical mirror candidate");
  }

  return [...candidates].sort((left, right) => {
    const costDelta = left.costMicros - right.costMicros;
    if (costDelta !== 0) {
      return costDelta;
    }
    const latencyDelta = left.latencyMs - right.latencyMs;
    if (latencyDelta !== 0) {
      return latencyDelta;
    }
    return left.mirrorId.localeCompare(right.mirrorId);
  })[0].mirrorId;
}

export function createFixtureMirror({
  mirrorId,
  artifactBytes,
  fetchBytes = artifactBytes,
  costMicros = 0,
  latencyMs = 0,
  verificationOk = true,
  verificationReasons = [],
  digestOverride,
  timeline,
} = {}) {
  if (!isNonEmptyString(mirrorId)) {
    throw new Error("mirrorId must be a non-empty string");
  }
  const verifiedBytes = toBuffer(artifactBytes, "artifactBytes");
  const fetchedBytes = toBuffer(fetchBytes, "fetchBytes");
  const digest = digestOverride ?? sha256Digest(verifiedBytes);

  return Object.freeze({
    mirrorId,
    costMicros,
    latencyMs,
    async verify() {
      pushTimeline(timeline, `verify:${mirrorId}`);
      return Object.freeze({
        ok: verificationOk,
        mirrorId,
        digest,
        costMicros,
        latencyMs,
        verificationRef: `${mirrorId}@${digest}`,
        assurance: verificationOk ? "hobo-add/install-time-verification-reused" : null,
        reasons: Object.freeze(verificationReasons),
      });
    },
    async fetch() {
      pushTimeline(timeline, `fetch:${mirrorId}`);
      return Object.freeze({
        bytes: Buffer.from(fetchedBytes),
      });
    },
  });
}

export function sha256Digest(bytes) {
  return `sha256:${createHash("sha256").update(toBuffer(bytes, "bytes")).digest("hex")}`;
}

async function verifyMirror({ mirror, coordinate, resolvedDigest }) {
  if (!mirror || !isJsonObject(mirror) || Array.isArray(mirror)) {
    throw new Error("mirror must be an object");
  }
  if (!isNonEmptyString(mirror.mirrorId)) {
    throw new Error("mirror.mirrorId must be a non-empty string");
  }
  if (!(mirror.verify instanceof Function)) {
    throw new Error(`${mirror.mirrorId}.verify must be a function`);
  }
  if (!(mirror.fetch instanceof Function)) {
    throw new Error(`${mirror.mirrorId}.fetch must be a function`);
  }

  const verification = await mirror.verify({
    coordinate: clone(coordinate),
    resolvedDigest,
  });
  const digest = verification?.digest;
  const ok = verification?.ok === true && SHA256_DIGEST_RE.test(digest);
  const reasons = [
    ...arrayOfStrings(verification?.reasons),
    ...(ok ? [] : [`${mirror.mirrorId}: install verification did not produce a trusted digest`]),
  ];

  return Object.freeze({
    ok,
    mirror,
    mirrorId: mirror.mirrorId,
    digest: SHA256_DIGEST_RE.test(digest) ? digest : null,
    costMicros: numberOrDefault(verification?.costMicros ?? mirror.costMicros, 0),
    latencyMs: numberOrDefault(verification?.latencyMs ?? mirror.latencyMs, 0),
    verificationRef: verification?.verificationRef ?? `${mirror.mirrorId}@unverified`,
    assurance: verification?.assurance ?? null,
    reasons: Object.freeze(reasons),
  });
}

function costCandidateFrom(verification) {
  return Object.freeze({
    mirrorId: verification.mirrorId,
    digest: verification.digest,
    costMicros: verification.costMicros,
    latencyMs: verification.latencyMs,
    verificationRef: verification.verificationRef,
    assurance: verification.assurance,
  });
}

function selectionFrom(verification) {
  return Object.freeze({
    mirrorId: verification.mirrorId,
    digest: verification.digest,
    costMicros: verification.costMicros,
    latencyMs: verification.latencyMs,
    verificationRef: verification.verificationRef,
  });
}

function failure({
  reason,
  reasons,
  coordinate,
  resolvedDigest,
  verifications,
  escalatedTo = null,
  costEligibleMirrorIds = [],
  selection = null,
  artifact = null,
}) {
  return Object.freeze({
    ok: false,
    reason,
    reasons: Object.freeze([...new Set(reasons.length > 0 ? reasons : [reason])]),
    contract: MIRROR_DIGEST_SELECTION_CONTRACT,
    coordinate: clone(coordinate),
    resolvedDigest,
    costEligibleMirrorIds: Object.freeze(costEligibleMirrorIds),
    selection,
    artifact,
    escalatedTo,
    verifications: Object.freeze(verifications.map(stripMirror)),
    auditEvent: Object.freeze({
      type: "artifact.MirrorSelectionFailed",
      contract: MIRROR_DIGEST_SELECTION_CONTRACT,
      coordinate: coordinateKey(coordinate),
      digest: resolvedDigest,
      reason,
      escalatedTo,
    }),
  });
}

function stripMirror(verification) {
  return Object.freeze({
    ok: verification.ok,
    mirrorId: verification.mirrorId,
    digest: verification.digest,
    costMicros: verification.costMicros,
    latencyMs: verification.latencyMs,
    verificationRef: verification.verificationRef,
    assurance: verification.assurance,
    reasons: Object.freeze([...verification.reasons]),
  });
}

function normalizeCoordinate(coordinate) {
  if (!coordinate || !isJsonObject(coordinate) || Array.isArray(coordinate)) {
    throw new Error("coordinate must be an object");
  }
  if (!isNonEmptyString(coordinate.name)) {
    throw new Error("coordinate.name must be a non-empty string");
  }
  if (!isNonEmptyString(coordinate.version)) {
    throw new Error("coordinate.version must be a non-empty string");
  }

  return Object.freeze({
    name: coordinate.name,
    version: coordinate.version,
  });
}

function coordinateKey(coordinate) {
  return `${coordinate.name}@${coordinate.version}`;
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

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter((entry) => isJsonString(entry)) : [];
}

function numberOrDefault(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
}

function pushTimeline(timeline, entry) {
  if (Array.isArray(timeline)) {
    timeline.push(entry);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
