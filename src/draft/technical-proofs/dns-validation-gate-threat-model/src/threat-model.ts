import { isJsonObject } from "./json.js";
export const DNS_VALIDATION_THREAT_MODEL_SCHEMA = "hobo.dns-validation-threat-model/v1";

export const REQUIRED_ATTACKS = Object.freeze([
  "lying-resolver",
  "split-horizon-answer",
  "propagation-cache-poisoning",
  "acme-challenge-misbinding",
  "health-probe-spoofing",
  "validate-promote-toc",
]);

export function createDnsValidationThreatModel(overrides = {}) {
  return deepMerge(
    {
      schema: DNS_VALIDATION_THREAT_MODEL_SCHEMA,
      decision: "dns-validation-gate-fail-closed-threat-model",
      issue: "HOBO-189",
      refs: ["PLAN-12", "ADR-0035", "ADR-0101", "HOBO-113", "HOBO-142", "HOBO-193"],
      invariants: {
        liveZoneUntouchedUntilValidated: true,
        failedOrUnfinishedCheckBlocksPromotion: true,
        noSingleVantageSuccess: true,
        noLastWriterWinsOnEvidenceDisagreement: true,
      },
      controls: {
        "multi-vantage-resolve": {
          minimumVantagePoints: 3,
          independence: ["recursive-network", "asn", "region"],
          disagreementPolicy: "fail-closed",
          evidenceFields: ["fqdn", "recordType", "expectedTargets", "answersByVantage", "observedAt"],
        },
        "ttl-aware-propagation": {
          waitForPreviousTtl: true,
          waitForCandidateTtl: true,
          requireStableSerialAcrossVantages: true,
          staleCachePolicy: "fail-closed",
        },
        "acme-challenge": {
          exactChallengeName: true,
          bindToFqdn: true,
          bindToKeyThumbprint: true,
          bindToCsrIdentifier: true,
          siblingOrWildcardSubstitution: "fail-closed",
        },
        "endpoint-health": {
          probeThroughCandidateHost: true,
          verifyExpectedGatewayIdentity: true,
          requireFreshProbeAfterDnsEvidence: true,
          statusPolicy: "2xx-or-3xx-only",
        },
        "promote-recheck": {
          recheckPinnedEvidenceBeforeLiveWrite: true,
          pinEvidenceDigest: true,
          maxWindowSeconds: 60,
          digestDriftPolicy: "fail-closed",
        },
      },
      attacks: [
        {
          slug: "lying-resolver",
          attacker: "one recursive resolver or vantage can return the attacker target",
          defeatedBy: ["multi-vantage-resolve"],
          minimumParameters: {
            minimumVantagePoints: 3,
            disagreementPolicy: "fail-closed",
          },
        },
        {
          slug: "split-horizon-answer",
          attacker: "the same FQDN resolves differently by geography, network, or tenant view",
          defeatedBy: ["multi-vantage-resolve"],
          minimumParameters: {
            independence: ["recursive-network", "asn", "region"],
            requireSameAnswersAcrossVantages: true,
          },
        },
        {
          slug: "propagation-cache-poisoning",
          attacker: "a stale or poisoned recursive cache claims the new record propagated",
          defeatedBy: ["ttl-aware-propagation", "multi-vantage-resolve"],
          minimumParameters: {
            waitForPreviousTtl: true,
            waitForCandidateTtl: true,
            requireStableSerialAcrossVantages: true,
          },
        },
        {
          slug: "acme-challenge-misbinding",
          attacker: "a sibling name or unrelated wildcard challenge is reused as evidence",
          defeatedBy: ["acme-challenge"],
          minimumParameters: {
            exactChallengeName: true,
            bindToFqdn: true,
            bindToKeyThumbprint: true,
            bindToCsrIdentifier: true,
          },
        },
        {
          slug: "health-probe-spoofing",
          attacker: "the old target, a generic health endpoint, or the wrong gateway answers healthy",
          defeatedBy: ["endpoint-health"],
          minimumParameters: {
            probeThroughCandidateHost: true,
            verifyExpectedGatewayIdentity: true,
            requireFreshProbeAfterDnsEvidence: true,
          },
        },
        {
          slug: "validate-promote-toc",
          attacker: "records flip after validation but before the live-zone write",
          defeatedBy: ["promote-recheck"],
          minimumParameters: {
            recheckPinnedEvidenceBeforeLiveWrite: true,
            pinEvidenceDigest: true,
            digestDriftPolicy: "fail-closed",
          },
        },
      ],
      downstreamRequirements: {
        "HOBO-142": [
          "Expose each required check result with enough evidence to compute the pinned digest.",
          "Fail validation on vantage disagreement instead of choosing a majority winner.",
          "Parameterize TTL waits from authoritative record metadata and previous live TTL.",
        ],
        "HOBO-193": [
          "Add red-team tests for post-validation rebinding, resolver spoofing, sibling-name ACME, and promote races.",
          "Re-check pinned evidence immediately before live-zone mutation.",
        ],
      },
      residualRisks: [
        "A coordinated authoritative-zone compromise can serve consistent malicious answers to every vantage; policy must detect via signed change provenance and operator audit.",
        "DNS rollback effective RTO remains bounded by the maximum cached TTL, not instantaneous.",
        "Regional internet partitions can make the safe result unavailable; the gate must block promotion rather than promote on partial evidence.",
      ],
    },
    overrides,
  );
}

export function validateDnsValidationThreatModel(model) {
  const errors = [];
  if (!model || !isJsonObject(model) || Array.isArray(model)) {
    return { ok: false, errors: ["model must be an object"], model: null };
  }

  if (model.schema !== DNS_VALIDATION_THREAT_MODEL_SCHEMA) {
    errors.push(`schema must be ${DNS_VALIDATION_THREAT_MODEL_SCHEMA}`);
  }
  if (model.decision !== "dns-validation-gate-fail-closed-threat-model") {
    errors.push("decision must be dns-validation-gate-fail-closed-threat-model");
  }
  if (model.invariants?.liveZoneUntouchedUntilValidated !== true) {
    errors.push("liveZoneUntouchedUntilValidated invariant is required");
  }
  if (model.invariants?.failedOrUnfinishedCheckBlocksPromotion !== true) {
    errors.push("failedOrUnfinishedCheckBlocksPromotion invariant is required");
  }
  validateControls(model.controls, errors);
  validateAttacks(model, errors);
  if (!Array.isArray(model.residualRisks) || model.residualRisks.length === 0) {
    errors.push("residualRisks must name at least one residual risk");
  }

  return {
    ok: errors.length === 0,
    errors,
    model: errors.length === 0 ? sortKeys(model) : null,
  };
}

export function evaluateDnsAttack(model, attackSlug, evidence = {}) {
  const parsed = validateDnsValidationThreatModel(model);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }
  const attack = parsed.model.attacks.find((candidate) => candidate.slug === attackSlug);
  if (!attack) {
    throw new Error(`unknown attack: ${attackSlug}`);
  }

  const failures = [];
  for (const controlName of attack.defeatedBy) {
    failures.push(...evaluateControl(controlName, parsed.model.controls[controlName], evidence[controlName] ?? {}));
  }

  return {
    attack: attackSlug,
    outcome: failures.length === 0 ? "defeated-by-gate" : "promotion-blocked",
    failures,
  };
}

function validateControls(controls, errors) {
  if (!controls || !isJsonObject(controls) || Array.isArray(controls)) {
    errors.push("controls must be an object");
    return;
  }

  if (!isPositiveInteger(controls["multi-vantage-resolve"]?.minimumVantagePoints)) {
    errors.push("multi-vantage-resolve.minimumVantagePoints must be a positive integer");
  } else if (controls["multi-vantage-resolve"].minimumVantagePoints < 3) {
    errors.push("multi-vantage-resolve requires at least three independent vantage points");
  }
  if (controls["multi-vantage-resolve"]?.disagreementPolicy !== "fail-closed") {
    errors.push("multi-vantage-resolve.disagreementPolicy must be fail-closed");
  }
  if (controls["ttl-aware-propagation"]?.waitForPreviousTtl !== true) {
    errors.push("ttl-aware-propagation must wait for previous TTL");
  }
  if (controls["ttl-aware-propagation"]?.waitForCandidateTtl !== true) {
    errors.push("ttl-aware-propagation must wait for candidate TTL");
  }
  if (controls["acme-challenge"]?.exactChallengeName !== true) {
    errors.push("acme-challenge.exactChallengeName is required");
  }
  if (controls["acme-challenge"]?.bindToFqdn !== true) {
    errors.push("acme-challenge.bindToFqdn is required");
  }
  if (controls["endpoint-health"]?.verifyExpectedGatewayIdentity !== true) {
    errors.push("endpoint-health.verifyExpectedGatewayIdentity is required");
  }
  if (controls["promote-recheck"]?.recheckPinnedEvidenceBeforeLiveWrite !== true) {
    errors.push("promote-recheck.recheckPinnedEvidenceBeforeLiveWrite is required");
  }
  if (controls["promote-recheck"]?.digestDriftPolicy !== "fail-closed") {
    errors.push("promote-recheck.digestDriftPolicy must be fail-closed");
  }
}

function validateAttacks(model, errors) {
  if (!Array.isArray(model.attacks)) {
    errors.push("attacks must be an array");
    return;
  }
  const attacksBySlug = new Map(model.attacks.map((attack) => [attack.slug, attack]));
  for (const slug of REQUIRED_ATTACKS) {
    const attack = attacksBySlug.get(slug);
    if (!attack) {
      errors.push(`missing attack: ${slug}`);
      continue;
    }
    if (!Array.isArray(attack.defeatedBy) || attack.defeatedBy.length === 0) {
      errors.push(`${slug} must name at least one defeating check`);
    }
    for (const control of attack.defeatedBy ?? []) {
      if (!model.controls?.[control]) {
        errors.push(`${slug} references unknown control ${control}`);
      }
    }
    if (!attack.minimumParameters || !isJsonObject(attack.minimumParameters)) {
      errors.push(`${slug} must name minimumParameters`);
    }
  }
}

function evaluateControl(controlName, control, evidence) {
  switch (controlName) {
    case "multi-vantage-resolve":
      return evaluateMultiVantage(control, evidence);
    case "ttl-aware-propagation":
      return evaluateTtlPropagation(evidence);
    case "acme-challenge":
      return evaluateAcmeChallenge(evidence);
    case "endpoint-health":
      return evaluateEndpointHealth(evidence);
    case "promote-recheck":
      return evaluatePromoteRecheck(evidence);
    default:
      return [`unknown control ${controlName}`];
  }
}

function evaluateMultiVantage(control, evidence) {
  const failures = [];
  const answers = evidence.answersByVantage ?? [];
  if (!Array.isArray(answers) || answers.length < control.minimumVantagePoints) {
    failures.push(`requires at least ${control.minimumVantagePoints} independent vantage answers`);
  }
  const uniqueAnswers = new Set(answers.map((answer) => JSON.stringify(answer.targets ?? [])));
  if (answers.length > 0 && uniqueAnswers.size !== 1) {
    failures.push("vantage answers disagree");
  }
  if (evidence.independent !== true) {
    failures.push("vantage independence not proven");
  }
  return failures;
}

function evaluateTtlPropagation(evidence) {
  const failures = [];
  if (!Number.isFinite(evidence.waitedSeconds) || !Number.isFinite(evidence.previousTtlSeconds)) {
    failures.push("previous TTL wait evidence is required");
  } else if (evidence.waitedSeconds < evidence.previousTtlSeconds) {
    failures.push("previous TTL has not elapsed");
  }
  if (!Number.isFinite(evidence.candidateTtlSeconds) || evidence.waitedSeconds < evidence.candidateTtlSeconds) {
    failures.push("candidate TTL has not elapsed");
  }
  if (evidence.stableSerialAcrossVantages !== true) {
    failures.push("stable serial across vantages not proven");
  }
  return failures;
}

function evaluateAcmeChallenge(evidence) {
  const failures = [];
  if (evidence.challengeName !== `_acme-challenge.${evidence.fqdn}`) {
    failures.push("challenge name must exactly match fqdn");
  }
  if (!evidence.keyThumbprint || evidence.keyThumbprint !== evidence.expectedKeyThumbprint) {
    failures.push("challenge key thumbprint mismatch");
  }
  if (!evidence.csrIdentifier || evidence.csrIdentifier !== evidence.expectedCsrIdentifier) {
    failures.push("challenge CSR binding mismatch");
  }
  return failures;
}

function evaluateEndpointHealth(evidence) {
  const failures = [];
  if (evidence.probedHost !== evidence.candidateHost) {
    failures.push("health probe must use candidate host");
  }
  if (evidence.gatewayIdentity !== evidence.expectedGatewayIdentity) {
    failures.push("gateway identity mismatch");
  }
  if (!Number.isInteger(evidence.status) || evidence.status < 200 || evidence.status >= 400) {
    failures.push("health status must be 2xx/3xx");
  }
  return failures;
}

function evaluatePromoteRecheck(evidence) {
  const failures = [];
  if (!evidence.pinnedDigest || evidence.pinnedDigest !== evidence.currentDigest) {
    failures.push("pinned validation evidence changed before promote");
  }
  if (evidence.liveZoneMutatedBeforePromote === true) {
    failures.push("live zone mutated before promote");
  }
  if (!Number.isFinite(evidence.windowSeconds) || evidence.windowSeconds > 60) {
    failures.push("validate-to-promote window exceeds bound");
  }
  return failures;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function deepMerge(base, overrides) {
  if (Array.isArray(base) || Array.isArray(overrides)) {
    return overrides === undefined ? structuredClone(base) : structuredClone(overrides);
  }
  if (!base || !isJsonObject(base)) {
    return overrides === undefined ? base : overrides;
  }

  const output = { ...structuredClone(base) };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    output[key] = deepMerge(output[key], value);
  }
  return output;
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}
