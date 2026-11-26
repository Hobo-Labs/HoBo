import { createHash } from "node:crypto";

import { validateCandidatePatch } from "../../training-engine-port-contract/src/training-engine-contract.js";
import { isJsonString, isJsonObject } from "./json.js";


export const CHAMPION_CHALLENGER_PROMOTION_SCHEMA = "hobo.champion-challenger-promotion/v1";

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const markerPrefix = "hobo:generated-region";

export class ChampionChallengerPromotionError extends Error {
  constructor(code, path = "$", message = code) {
    super(`${code} at ${path}: ${message}`);
    this.name = "ChampionChallengerPromotionError";
    this.code = code;
    this.path = path;
  }
}

export function findGeneratedRegion(source, regionId, { artifactRef = "git://repo/src/support.ts#classifyTicket" } = {}) {
  assertNonEmptyString(source, "promotion.source_required", "$.source");
  assertNonEmptyString(regionId, "promotion.region_id_required", "$.regionId");

  const beginPattern = new RegExp(
    `(^|\\n)(?<indent>\\s*)// ${markerPrefix} begin region=${escapeRegExp(regionId)} owner=(?<owner>\\S+)`,
  );
  const begin = beginPattern.exec(source);
  if (!begin?.groups) {
    throw new ChampionChallengerPromotionError("promotion.region_marker_missing", "$.source");
  }

  const beginLineEnd = source.indexOf("\n", begin.index + begin[0].length);
  if (beginLineEnd < 0) {
    throw new ChampionChallengerPromotionError("promotion.region_marker_unclosed", "$.source");
  }

  const endMarker = `${begin.groups.indent}// ${markerPrefix} end region=${regionId}`;
  const endOffset = source.indexOf(endMarker, beginLineEnd + 1);
  if (endOffset < 0) {
    throw new ChampionChallengerPromotionError("promotion.region_marker_unclosed", "$.source");
  }

  return {
    regionId,
    artifactRef,
    startOffset: beginLineEnd + 1,
    endOffset,
    owner: begin.groups.owner,
  };
}

export function checkGeneratedRegionDrift({ source, expectedSource, regionId }) {
  const currentRegion = findGeneratedRegion(source, regionId);
  const expectedRegion = findGeneratedRegion(expectedSource, regionId);
  const currentRegionSource = source.slice(currentRegion.startOffset, currentRegion.endOffset);
  const expectedRegionSource = expectedSource.slice(expectedRegion.startOffset, expectedRegion.endOffset);
  const handWrittenChanged =
    withoutGeneratedRegion(source, currentRegion) !== withoutGeneratedRegion(expectedSource, expectedRegion);

  if (currentRegionSource === expectedRegionSource) {
    return {
      ok: true,
      code: null,
      handWrittenChanged,
    };
  }

  return {
    ok: false,
    code: "promotion.generated_region_drift",
    handWrittenChanged,
    expectedDigest: digest(expectedRegionSource),
    actualDigest: digest(currentRegionSource),
  };
}

export function createChampionChallengerPromotion({ now = () => "2026-06-28T19:10:00.000Z" } = {}) {
  return Object.freeze({
    shadowTraffic({ champion, challenger, requests }) {
      if (!(champion instanceof Function) || !(challenger instanceof Function)) {
        throw new ChampionChallengerPromotionError("promotion.callable_required", "$.shadow");
      }
      if (!Array.isArray(requests)) {
        throw new ChampionChallengerPromotionError("promotion.requests_required", "$.requests");
      }

      const samples = requests.map((request, index) => {
        const championResponse = champion(request);
        const challengerResponse = challenger(request);
        return {
          index,
          request,
          championResponse,
          challengerResponse,
          servedResponse: championResponse,
          challengerServed: false,
        };
      });

      return {
        schema: CHAMPION_CHALLENGER_PROMOTION_SCHEMA,
        mode: "shadow",
        samples,
      };
    },

    promote(input) {
      return promoteCandidate({ ...input, ts: now() });
    },

    revert(input) {
      return revertPromotion(input);
    },
  });
}

export function promoteCandidate({
  source,
  region,
  candidate,
  gate,
  provenance,
  environment,
  riskClass,
  ts = "2026-06-28T19:10:00.000Z",
}) {
  assertCertifiedGate(gate);
  validateSignedProvenance(provenance);

  if (isCandidateAlreadyApplied(source, candidate)) {
    return {
      schema: CHAMPION_CHALLENGER_PROMOTION_SCHEMA,
      effect: "already-applied",
      source,
      delta: null,
      events: [],
    };
  }

  const currentRegion = assertRegionMatchesSource(source, region);
  const patchValidation = validateCandidatePatch(candidate, currentRegion);
  if (!patchValidation.ok) {
    throw new ChampionChallengerPromotionError(
      "promotion.candidate_patch_invalid",
      "$.candidate",
      patchValidation.errors.join("; "),
    );
  }

  const edits = normalizeEdits(patchValidation.candidate.edits, source);
  const previousRegionSource = source.slice(currentRegion.startOffset, currentRegion.endOffset);
  if (environment === "prod" || environment === "production" || riskClass === "high") {
    return {
      schema: CHAMPION_CHALLENGER_PROMOTION_SCHEMA,
      effect: "pr-delta",
      source,
      delta: {
        kind: "source-pr-delta",
        regionId: currentRegion.regionId,
        candidateId: candidate.id,
        edits,
        provenanceDigest: digest(provenance),
      },
      events: [promotionEvent("training.Promoted", candidate, currentRegion, ts, "pending-pr-delta")],
    };
  }

  const nextSource = applyRegionEdits(source, edits);
  const promotedRegionSource = edits[0].replacement;
  return {
    schema: CHAMPION_CHALLENGER_PROMOTION_SCHEMA,
    effect: "auto-applied",
    source: nextSource,
    delta: null,
    events: [
      promotionEvent("training.Promoted", candidate, currentRegion, ts, "auto-applied", {
        previousRegionSource,
        promotedRegionSource,
        startOffset: edits[0].startOffset,
      }),
      promotionEvent("impl.Promoted", candidate, currentRegion, ts, "auto-applied", {
        previousRegionSource,
        promotedRegionSource,
        startOffset: edits[0].startOffset,
      }),
    ],
  };
}

function assertRegionMatchesSource(source, region) {
  const currentRegion = findGeneratedRegion(source, region?.regionId, {
    artifactRef: region?.artifactRef,
  });
  if (currentRegion.startOffset !== region?.startOffset || currentRegion.endOffset !== region?.endOffset) {
    throw new ChampionChallengerPromotionError("promotion.region_boundary_mismatch", "$.region");
  }
  return currentRegion;
}

function isCandidateAlreadyApplied(source, candidate) {
  try {
    const currentRegion = findGeneratedRegion(source, candidate?.region?.regionId, {
      artifactRef: candidate?.region?.artifactRef,
    });
    const currentRegionSource = source.slice(currentRegion.startOffset, currentRegion.endOffset);
    const replacement = candidate?.edits?.[0]?.replacement;
    if (!isJsonString(replacement)) {
      return false;
    }
    const normalizedReplacement =
      currentRegionSource.endsWith("\n") && !replacement.endsWith("\n") ? `${replacement}\n` : replacement;
    return currentRegionSource === normalizedReplacement;
  } catch {
    return false;
  }
}

function withoutGeneratedRegion(source, region) {
  return `${source.slice(0, region.startOffset)}<generated-region:${region.regionId}>${source.slice(region.endOffset)}`;
}

export function revertPromotion({ source, events, candidateId }) {
  assertNonEmptyString(source, "promotion.source_required", "$.source");
  assertNonEmptyString(candidateId, "promotion.candidate_id_required", "$.candidateId");
  if (!Array.isArray(events)) {
    throw new ChampionChallengerPromotionError("promotion.events_required", "$.events");
  }

  const promoted = [...events]
    .reverse()
    .find((event) => event.type === "impl.Promoted" && event.candidateId === candidateId);
  if (
    !promoted?.data?.previousRegionSource ||
    !promoted?.data?.promotedRegionSource ||
    !Number.isInteger(promoted.data.startOffset)
  ) {
    throw new ChampionChallengerPromotionError("promotion.revert_snapshot_missing", "$.events");
  }

  const startOffset = promoted.data.startOffset;
  const endOffset = startOffset + promoted.data.promotedRegionSource.length;
  if (source.slice(startOffset, endOffset) !== promoted.data.promotedRegionSource) {
    throw new ChampionChallengerPromotionError("promotion.revert_current_region_mismatch", "$.source");
  }

  return {
    schema: CHAMPION_CHALLENGER_PROMOTION_SCHEMA,
    effect: "reverted",
    source: `${source.slice(0, startOffset)}${promoted.data.previousRegionSource}${source.slice(endOffset)}`,
  };
}

function assertCertifiedGate(gate) {
  if (!gate || gate.certified !== true || !["certify", "approved"].includes(gate.effect)) {
    throw new ChampionChallengerPromotionError("promotion.gate_not_green", "$.gate");
  }
}

function validateSignedProvenance(provenance) {
  if (!provenance || !isJsonObject(provenance) || Array.isArray(provenance)) {
    throw new ChampionChallengerPromotionError("promotion.provenance_required", "$.provenance");
  }
  if (provenance.kind !== "generation-provenance") {
    throw new ChampionChallengerPromotionError("promotion.provenance_kind", "$.provenance.kind");
  }
  if (provenance.signature?.alg !== "Ed25519" || !provenance.signature?.value) {
    throw new ChampionChallengerPromotionError("promotion.provenance_signature_required", "$.provenance.signature");
  }
  if (!digestPattern.test(provenance.signature.payloadDigest ?? "")) {
    throw new ChampionChallengerPromotionError("promotion.provenance_signature_digest", "$.provenance.signature");
  }
  if (provenance.payload?.schema !== "hobo.generation.provenance/v1") {
    throw new ChampionChallengerPromotionError("promotion.provenance_payload_schema", "$.provenance.payload");
  }
  for (const path of [
    "$.payload.model.digest",
    "$.payload.prompt.frozenPromptDigest",
    "$.payload.artifact.digest",
    "$.payload.conformanceReportRef.digest",
  ]) {
    if (!digestPattern.test(valueAtPath(provenance, path) ?? "")) {
      throw new ChampionChallengerPromotionError("promotion.provenance_digest", path);
    }
  }
  if (!Array.isArray(provenance.payload.evalReportRefs) || provenance.payload.evalReportRefs.length === 0) {
    throw new ChampionChallengerPromotionError("promotion.provenance_eval_required", "$.provenance.payload.evalReportRefs");
  }
}

function normalizeEdits(edits, source) {
  return edits.map((edit) => {
    const original = source.slice(edit.startOffset, edit.endOffset);
    const needsTrailingNewline = original.endsWith("\n") && !edit.replacement.endsWith("\n");
    return {
      startOffset: edit.startOffset,
      endOffset: edit.endOffset,
      replacement: needsTrailingNewline ? `${edit.replacement}\n` : edit.replacement,
    };
  });
}

function applyRegionEdits(source, edits) {
  return [...edits]
    .sort((left, right) => right.startOffset - left.startOffset)
    .reduce(
      (current, edit) => `${current.slice(0, edit.startOffset)}${edit.replacement}${current.slice(edit.endOffset)}`,
      source,
    );
}

function promotionEvent(type, candidate, region, ts, effect, data = {}) {
  return {
    schema: CHAMPION_CHALLENGER_PROMOTION_SCHEMA,
    id: `${candidate.id}:${type}`,
    type,
    ts,
    candidateId: candidate.id,
    regionId: region.regionId,
    effect,
    data,
  };
}

function assertNonEmptyString(value, code, path) {
  if (!isJsonString(value) || value.length === 0) {
    throw new ChampionChallengerPromotionError(code, path);
  }
}

function valueAtPath(value, path) {
  return path
    .replace(/^\$\./, "")
    .split(".")
    .reduce((current, key) => current?.[key], value);
}

function digest(value) {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function stableJson(value) {
  if (value === null || !isJsonObject(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
