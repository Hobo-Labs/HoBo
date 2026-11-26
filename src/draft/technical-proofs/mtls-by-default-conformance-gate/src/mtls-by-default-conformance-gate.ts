import { ConnectivityTier } from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.js";
import { parseWorkloadSpiffeId } from "../../mtls-data-path-contract/src/mtls-data-path.js";
import { isJsonString, isJsonObject } from "./json.js";


export const MTLS_BY_DEFAULT_CONFORMANCE_SCHEMA_VERSION = "hobo.mtls-by-default-conformance/v1";

export const CheckFidelity = Object.freeze({
  LOCAL: "local",
  CAMP: "camp"
});

const REQUIRED_TIERS = Object.freeze([
  ConnectivityTier.SAME_PROVIDER_REGION,
  ConnectivityTier.SAME_PROVIDER_CROSS_REGION,
  ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT,
  ConnectivityTier.OVERLAY_MESH,
  ConnectivityTier.PUBLIC_MTLS
]);

const TIER_LABEL = Object.freeze({
  [ConnectivityTier.SAME_PROVIDER_REGION]: "tier 1",
  [ConnectivityTier.SAME_PROVIDER_CROSS_REGION]: "tier 2",
  [ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT]: "tier 3",
  [ConnectivityTier.OVERLAY_MESH]: "tier 4",
  [ConnectivityTier.PUBLIC_MTLS]: "tier 5"
});

const CHECK_KINDS = Object.freeze({
  svidMtlsHandshake: "svid-mtls-handshake",
  plaintextPeer: "plaintext-peer-rejection",
  crossTenantPeer: "cross-tenant-peer-rejection"
});

export function runMtlsByDefaultConformanceGate(input = {}) {
  const targets = Array.isArray(input.targets) ? input.targets : [];
  const requiredTiers = Array.isArray(input.requiredTiers) && input.requiredTiers.length > 0
    ? input.requiredTiers
    : REQUIRED_TIERS;

  const targetsByTier = new Map();
  for (const target of targets) {
    if (!targetsByTier.has(target?.tier)) {
      targetsByTier.set(target?.tier, target);
    }
  }

  const checks = [];
  const failures = [];
  const coveredTiers = [];

  for (const tier of requiredTiers) {
    const target = targetsByTier.get(tier);
    if (!target) {
      failures.push(failure(tier, null, "mtls.tier.missing", `${tierName(tier)} is missing from mTLS-by-default conformance coverage`));
      continue;
    }

    coveredTiers.push(tier);
    const targetFailure = validateTarget(target, checks);
    if (targetFailure) failures.push(targetFailure);
  }

  return {
    schemaVersion: MTLS_BY_DEFAULT_CONFORMANCE_SCHEMA_VERSION,
    ok: failures.length === 0,
    coveredTiers,
    checks,
    failures
  };
}

function validateTarget(target, checks) {
  const tier = target.tier;
  const edgeId = stringOrNull(target.edgeId);

  if (target.mtls?.ok !== true) {
    return failure(tier, edgeId, "mtls.tier.mtls-missing", `${tierName(tier)} did not prove an SVID-keyed mTLS handshake`);
  }

  const identityFailure = validateBoundIdentities(target);
  if (identityFailure) return identityFailure;

  const handshakeFailure = validateHandshakeCheck(target, checks);
  if (handshakeFailure) return handshakeFailure;

  const plaintextFailure = validateRejectionCheck({
    target,
    checks,
    key: "plaintextPeer",
    failureCode: "mtls.tier.plaintext-accepted",
    failureReason: `${tierName(tier)} accepted unauthenticated/plaintext traffic`
  });
  if (plaintextFailure) return plaintextFailure;

  return validateRejectionCheck({
    target,
    checks,
    key: "crossTenantPeer",
    failureCode: "mtls.tier.cross-tenant-accepted",
    failureReason: `${tierName(tier)} accepted a peer from another tenant trust domain`
  });
}

function validateBoundIdentities(target) {
  try {
    const source = parseWorkloadSpiffeId(target.source?.svid);
    const peer = parseWorkloadSpiffeId(target.target?.svid);
    if (source.tenant !== peer.tenant || source.trustDomain !== peer.trustDomain) {
      return failure(
        target.tier,
        stringOrNull(target.edgeId),
        "mtls.tier.identity-mismatch",
        `${tierName(target.tier)} source and target SVIDs must share a tenant trust domain`
      );
    }
    if (target.mtls?.peer?.resource !== peer.resource) {
      return failure(
        target.tier,
        stringOrNull(target.edgeId),
        "mtls.tier.peer-mismatch",
        `${tierName(target.tier)} mTLS peer ${target.mtls?.peer?.resource ?? "<missing>"} does not match target ${peer.resource}`
      );
    }
    if (target.mtls?.peer?.tenant !== peer.tenant || target.mtls?.peer?.trustDomain !== peer.trustDomain) {
      return failure(
        target.tier,
        stringOrNull(target.edgeId),
        "mtls.tier.peer-mismatch",
        `${tierName(target.tier)} mTLS peer must use the target tenant trust domain`
      );
    }
  } catch (error) {
    return failure(target.tier, stringOrNull(target.edgeId), "mtls.tier.identity-invalid", error.message);
  }
  return null;
}

function validateHandshakeCheck(target, checks) {
  const tier = target.tier;
  const edgeId = stringOrNull(target.edgeId);
  const check = target.checks?.svidMtlsHandshake;
  const normalized = pushCheck({ target, checks, key: "svidMtlsHandshake" });

  if (!normalized || check?.status !== "passed") {
    return failure(tier, edgeId, "mtls.tier.mtls-missing", `${tierName(tier)} did not prove an SVID-keyed mTLS handshake`);
  }

  const campRequired = target.handshakeScope === "cross-cloud" || target.campOnly === true;
  if (campRequired && check.fidelity !== CheckFidelity.CAMP) {
    return failure(tier, edgeId, "mtls.coverage.cross-cloud-mislabeled", `${tierName(tier)} cross-cloud handshake must be tagged camp`);
  }
  if (!campRequired && check.fidelity !== CheckFidelity.LOCAL) {
    return failure(tier, edgeId, "mtls.coverage.local-mislabeled", `${tierName(tier)} intra-tier handshake must be tagged local`);
  }

  if (check.fidelity === CheckFidelity.CAMP && (!isNonEmptyString(check.evidenceRef) || !isIsoDate(check.ranAt))) {
    return failure(tier, edgeId, "mtls.coverage.camp-not-run", `${tierName(tier)} marked a camp-only handshake green without camp run evidence`);
  }

  if (check.fidelity !== CheckFidelity.CAMP && check.fidelity !== CheckFidelity.LOCAL) {
    return failure(tier, edgeId, "mtls.coverage.invalid-fidelity", `${tierName(tier)} check fidelity must be local or camp`);
  }

  return null;
}

function validateRejectionCheck({ target, checks, key, failureCode, failureReason }) {
  const check = target.checks?.[key];
  const normalized = pushCheck({ target, checks, key });
  if (!normalized || check?.status !== "rejected") {
    return failure(target.tier, stringOrNull(target.edgeId), failureCode, failureReason);
  }
  if (check.fidelity !== CheckFidelity.LOCAL) {
    return failure(
      target.tier,
      stringOrNull(target.edgeId),
      "mtls.coverage.local-mislabeled",
      `${tierName(target.tier)} ${CHECK_KINDS[key]} must be tagged local`
    );
  }
  return null;
}

function pushCheck({ target, checks, key }) {
  const check = target.checks?.[key];
  if (!check || !isJsonObject(check) || Array.isArray(check)) return null;

  const normalized = {
    tier: target.tier,
    edgeId: stringOrNull(target.edgeId),
    kind: CHECK_KINDS[key],
    status: check.status,
    fidelity: check.fidelity
  };
  if (check.evidenceRef !== undefined) normalized.evidenceRef = check.evidenceRef;
  if (check.ranAt !== undefined) normalized.ranAt = check.ranAt;
  if (check.code !== undefined) normalized.code = check.code;

  checks.push(normalized);
  return normalized;
}

function failure(tier, edgeId, code, reason) {
  return { tier, edgeId, code, reason };
}

function tierName(tier) {
  return TIER_LABEL[tier] ?? `tier ${tier}`;
}

function stringOrNull(value) {
  return isJsonString(value) && value.length > 0 ? value : null;
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.length > 0;
}

function isIsoDate(value) {
  return isJsonString(value) && !Number.isNaN(new Date(value).getTime());
}
