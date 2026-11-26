import { routeCrossCampTraffic } from "../../cross-camp-routing-policy-contract/src/cross-camp-routing-policy.js";
import { isJsonString, isJsonObject } from "./json.js";


export function evaluateSplitHorizonResolution(check) {
  const normalized = normalizeResolutionCheck(check);
  const insufficientDimensions = insufficientVantageDimensions(normalized.answersByVantage);
  if (insufficientDimensions.length > 0) {
    return {
      ok: false,
      code: "dns.vantage-independence.insufficient",
      reason: `${normalized.fqdn} requires independent DNS vantage evidence`,
      promotion: "blocked",
      insufficientDimensions,
    };
  }

  const expectedKey = targetsKey(normalized.expectedTargets);
  const disagreeingVantages = normalized.answersByVantage
    .filter((answer) => targetsKey(answer.targets) !== expectedKey)
    .map((answer) => answer.id);

  if (disagreeingVantages.length > 0) {
    return {
      ok: false,
      code: "dns.split-horizon.detected",
      reason: `${normalized.fqdn} resolved differently across independent vantages`,
      promotion: "blocked",
      disagreeingVantages,
    };
  }

  return {
    ok: true,
    promotion: "allowed",
  };
}

export function routeWithPartitionSafety(input) {
  const localYardId = requiredString(input?.localYardId, "localYardId");
  const campYards = input?.campYards ?? {};
  const routed = routeCrossCampTraffic(input?.routingRequest);
  if (routed.status !== "routed") {
    return routed;
  }

  const targetCamp = routed.record.targets[0]?.camp;
  const targetYardId = requiredString(campYards[targetCamp], `campYards.${targetCamp}`);
  if (targetYardId === localYardId) {
    return routed;
  }

  const trust = evaluateTrustLeaseFreshness({
    ...input.trust,
    yardId: localYardId,
    peerYardId: targetYardId,
  });
  if (!trust.ok) {
    return {
      status: "refused",
      code: "routing.partition.unconfirmable-target",
      reason: `failover target ${targetCamp} is unconfirmable during cross-Yard partition`,
      events: [],
    };
  }

  return routed;
}

export function reconcilePartitionRecovery(input) {
  const localYardId = requiredString(input?.localYardId, "localYardId");
  const peerYardId = requiredString(input?.peerYardId, "peerYardId");
  const trustInput = {
    yardId: localYardId,
    peerYardId,
    now: input?.now,
    maxLeaseTtlMs: input?.maxLeaseTtlMs,
    canConfirmWithRoot: input?.canConfirmWithRoot,
    trustEvents: input?.trustEvents,
  };
  const trust = evaluateTrustLeaseFreshness(trustInput);
  if (!trust.ok) {
    return {
      status: "held",
      operatorActionRequired: false,
      trust,
    };
  }

  const routing = routeWithPartitionSafety({
    localYardId,
    campYards: input?.campYards,
    trust: trustInput,
    routingRequest: input?.routingRequest,
  });

  return {
    status: routing.status === "routed" ? "reconverged" : "held",
    operatorActionRequired: false,
    appliedTrustSequence: trust.sequence,
    routing,
  };
}

export function evaluateTrustLeaseFreshness(input) {
  const normalized = normalizeTrustLeaseInput(input);
  const latest = latestTrustEvent(normalized.trustEvents, normalized.peerYardId);
  if (!latest) {
    return failClosedTrust(normalized, "junction.trust-lease.missing");
  }

  if (latest.type === "junction.TrustRevoked") {
    return {
      ok: false,
      code: "junction.trust-revoked",
      guarantee: "fail-closed",
      reason: `${normalized.yardId} applied revocation sequence ${latest.sequence} for ${normalized.peerYardId}`,
      actions: ["stop-honoring-peer-principals", "hold-routing-to-peer"],
    };
  }

  const leaseExpired = normalized.nowMs > Date.parse(latest.validUntil);
  const leaseExceedsTtl = Date.parse(latest.validUntil) - Date.parse(latest.issuedAt) > normalized.maxLeaseTtlMs;
  if (leaseExceedsTtl) {
    return failClosedTrust(normalized, "junction.trust-lease.ttl-exceeded");
  }

  if (leaseExpired || normalized.canConfirmWithRoot !== true) {
    return failClosedTrust(normalized, "junction.trust-lease.stale");
  }

  return {
    ok: true,
    guarantee: "peer-trust-fresh",
    peerYardId: normalized.peerYardId,
    sequence: latest.sequence,
  };
}

function normalizeTrustLeaseInput(input) {
  if (!input || !isJsonObject(input) || Array.isArray(input)) {
    throw new TypeError("trust lease input is required");
  }
  const nowMs = timestampMs(input.now, "now");
  const maxLeaseTtlMs = finitePositiveNumber(input.maxLeaseTtlMs, "maxLeaseTtlMs");
  return {
    yardId: requiredString(input.yardId, "yardId"),
    peerYardId: requiredString(input.peerYardId, "peerYardId"),
    nowMs,
    maxLeaseTtlMs,
    canConfirmWithRoot: input.canConfirmWithRoot,
    trustEvents: parseTrustEvents(input.trustEvents),
  };
}

function parseTrustEvents(events) {
  if (!Array.isArray(events)) {
    throw new TypeError("trustEvents must be an array");
  }
  return events.map((event, index) => ({
    type: requiredString(event?.type, `trustEvents[${index}].type`),
    sequence: finitePositiveNumber(event?.sequence, `trustEvents[${index}].sequence`),
    peerYardId: requiredString(event?.peerYardId, `trustEvents[${index}].peerYardId`),
    issuedAt: requiredTimestamp(event?.issuedAt, `trustEvents[${index}].issuedAt`),
    validUntil: requiredTimestamp(event?.validUntil, `trustEvents[${index}].validUntil`),
  }));
}

function latestTrustEvent(events, peerYardId) {
  return events
    .filter((event) => event.peerYardId === peerYardId)
    .sort((left, right) => right.sequence - left.sequence)[0];
}

function failClosedTrust(input, code) {
  return {
    ok: false,
    code,
    guarantee: "fail-closed",
    reason: `${input.yardId} cannot confirm ${input.peerYardId} trust freshness within ${input.maxLeaseTtlMs}ms`,
    actions: ["stop-honoring-peer-principals", "hold-routing-to-peer"],
  };
}

function normalizeResolutionCheck(check) {
  if (!check || !isJsonObject(check) || Array.isArray(check)) {
    throw new TypeError("resolution check is required");
  }
  return {
    fqdn: requiredString(check.fqdn, "fqdn"),
    recordType: requiredString(check.recordType, "recordType").toUpperCase(),
    expectedTargets: sortedTargets(check.expectedTargets, "expectedTargets"),
    answersByVantage: parseVantageAnswers(check.answersByVantage),
  };
}

function parseVantageAnswers(answers) {
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new TypeError("answersByVantage must be a non-empty array");
  }
  return answers.map((answer, index) => ({
    id: requiredString(answer?.id, `answersByVantage[${index}].id`),
    resolverNetwork: requiredString(answer?.resolverNetwork, `answersByVantage[${index}].resolverNetwork`),
    asn: finitePositiveNumber(answer?.asn, `answersByVantage[${index}].asn`),
    region: requiredString(answer?.region, `answersByVantage[${index}].region`),
    targets: sortedTargets(answer?.targets, `answersByVantage[${index}].targets`),
  }));
}

function insufficientVantageDimensions(answers) {
  return ["resolverNetwork", "asn", "region"].filter((dimension) => {
    const values = new Set(answers.map((answer) => answer[dimension]));
    return values.size !== answers.length;
  });
}

function sortedTargets(targets, path) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new TypeError(`${path} must be a non-empty array`);
  }
  return targets.map((target, index) => requiredString(target, `${path}[${index}]`)).sort();
}

function targetsKey(targets) {
  return JSON.stringify(targets);
}

function requiredString(value, path) {
  if (!isJsonString(value) || value.trim() === "") {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function finitePositiveNumber(value, path) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${path} must be a positive number`);
  }
  return value;
}

function requiredTimestamp(value, path) {
  const parsed = requiredString(value, path);
  timestampMs(parsed, path);
  return parsed;
}

function timestampMs(value, path) {
  const parsed = Date.parse(requiredString(value, path));
  if (Number.isNaN(parsed)) {
    throw new TypeError(`${path} must be an ISO-8601 timestamp`);
  }
  return parsed;
}
