import { readFileSync } from "node:fs";

export const POST_CORE_DELTA_PATTERN = Object.freeze({
  issue: "HOBO-524",
  sourceM0Issue: "HOBO-521",
  capability: "Meta-cloud Broker",
  requiredRecords: Object.freeze([
    "linear-project",
    "m0-acceptance-record",
    "design-index-row",
    "proof-readme",
    "traceability-row",
    "blocked-follow-up-skeleton",
  ]),
  adversarialGuards: Object.freeze([
    "completed-epics-are-not-mutable-catch-alls",
    "docs-only-claims-require-linear-owner-and-proof-path",
  ]),
});

export function validatePostCoreDeltaPattern(pattern: typeof POST_CORE_DELTA_PATTERN) {
  const errors = [];

  if (pattern.issue !== "HOBO-524") {
    errors.push("Pattern must be owned by HOBO-524.");
  }
  if (pattern.sourceM0Issue !== "HOBO-521") {
    errors.push("Pattern must cite HOBO-521 as the accepted M0 broker record.");
  }
  if (!/Meta-cloud Broker/i.test(pattern.capability ?? "")) {
    errors.push("Pattern must name the Meta-cloud Broker capability.");
  }

  for (const record of [
    "linear-project",
    "m0-acceptance-record",
    "design-index-row",
    "proof-readme",
    "traceability-row",
    "blocked-follow-up-skeleton",
  ]) {
    if (!pattern.requiredRecords?.includes(record)) {
      errors.push(`Missing required record: ${record}.`);
    }
  }

  for (const guard of [
    "completed-epics-are-not-mutable-catch-alls",
    "docs-only-claims-require-linear-owner-and-proof-path",
  ]) {
    if (!pattern.adversarialGuards?.includes(guard)) {
      errors.push(`Missing adversarial guard: ${guard}.`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function classifyPostCoreDeltaClaim({
  target,
  claim,
  linearOwner,
  proofPath,
}: {
  target?: string;
  claim?: string;
  linearOwner?: string;
  proofPath?: string;
} = {}) {
  const normalizedTarget = String(target ?? "");
  const normalizedClaim = String(claim ?? "");

  if (/completed-epic/i.test(normalizedTarget) || /old .*epic|completed .*epic/i.test(normalizedClaim)) {
    return {
      allowed: false,
      reason: "Post-core deltas must not make completed epics mutable catch-alls.",
    };
  }

  if (!linearOwner || !proofPath) {
    return {
      allowed: false,
      reason: "Post-core delta claims require a Linear owner and executable proof path.",
    };
  }

  return {
    allowed: true,
    reason: "Post-core delta has an owning Linear issue and executable proof path.",
  };
}

export function assertDocsCarryPostCoreDeltaPattern(repoRootUrl: URL) {
  const designIndex = readText(repoRootUrl, "docs/design/index.md");
  const traceability = readText(repoRootUrl, "docs/design/traceability.md");
  const errors = [];

  if (!/\[.+meta-cloud-broker\.md.+\]/i.test(designIndex)) {
    errors.push("Design index must point to the Meta-cloud Broker design record.");
  }

  if (!/HOBO-521/.test(traceability) || !/meta-cloud-broker-scope-contract/.test(traceability)) {
    errors.push("Traceability must include the accepted HOBO-521 broker M0 record.");
  }
  if (!/HOBO-524/.test(traceability) || !/post-core-cross-cutting-delta-pattern/.test(traceability)) {
    errors.push("Traceability must include the HOBO-524 docs-pattern proof.");
  }

  return { ok: errors.length === 0, errors, designIndex, traceability };
}

function readText(repoRootUrl: URL, relativePath: string) {
  return readFileSync(new URL(relativePath, repoRootUrl), "utf8");
}
