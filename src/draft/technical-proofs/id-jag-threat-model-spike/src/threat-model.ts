export const REQUIRED_DRAFT_VERSION =
  "draft-ietf-oauth-identity-assertion-authz-grant-04";

export const REQUIRED_THREAT_IDS = [
  "stage1-assertion-theft-replay",
  "stage2-audience-resource-confusion",
  "idp-compromise-blast-radius",
  "scope-upgrade-at-redemption",
  "draft-version-skew",
  "fallback-downgrade-to-obo",
  "actor-token-confusion",
  "pop-dpop-downgrade",
  "refresh-token-subject-broadening"
];

const ALLOWED_HANDOFFS = new Set([
  "HOBO-43",
  "HOBO-54",
  "HOBO-83",
  "HOBO-162",
  "HOBO-250",
  "HOBO-255"
]);

export function validateThreatModel(model) {
  const errors = [];

  if (model?.draft?.pinnedVersion !== REQUIRED_DRAFT_VERSION) {
    errors.push(
      `draft pin must remain ${REQUIRED_DRAFT_VERSION} until a vector-diff review updates it`
    );
  }

  const reviewTriggers = model?.draft?.reviewTriggers ?? [];
  if (!reviewTriggers.some((trigger) => /newer draft revision/i.test(trigger))) {
    errors.push("draft review triggers must include Datatracker revision changes");
  }
  if ((model?.draft?.requiredRevalidation ?? []).length < 3) {
    errors.push("draft pin changes must carry explicit revalidation steps");
  }

  const threats = model?.threats ?? [];
  const actualIds = threats.map((threat) => threat.id).sort();
  const expectedIds = [...REQUIRED_THREAT_IDS].sort();
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    errors.push(`threat ids must exactly match ${expectedIds.join(", ")}`);
  }
  const priorities = threats.map((threat) => threat.priority).sort((a, b) => a - b);
  const expectedPriorities = REQUIRED_THREAT_IDS.map((_, index) => index + 1);
  if (JSON.stringify(priorities) !== JSON.stringify(expectedPriorities)) {
    errors.push("threat priorities must be unique, contiguous, and cover every vector");
  }

  for (const threat of threats) {
    if (!Number.isInteger(threat.priority) || threat.priority < 1) {
      errors.push(`${threat.id} must include a positive integer priority`);
    }
    if (!threat.mitigation || !threat.requiredRegression) {
      errors.push(`${threat.id} must include mitigation and requiredRegression`);
    }
    if (threat.failClosed !== true) {
      errors.push(`${threat.id} must fail closed`);
    }
    if (!Array.isArray(threat.controls) || threat.controls.length < 2) {
      errors.push(`${threat.id} must name concrete controls`);
    }
    if (!Array.isArray(threat.handoff) || threat.handoff.length === 0) {
      errors.push(`${threat.id} must map to at least one handoff issue`);
    }
    for (const issue of threat.handoff ?? []) {
      if (!ALLOWED_HANDOFFS.has(issue)) {
        errors.push(`${threat.id} has unexpected handoff issue ${issue}`);
      }
    }
  }

  requireControls(errors, threats, "draft-version-skew", [
    "draft-version-pin",
    "metadata-match",
    "conformance-vector-diff",
    "pin-bump-review"
  ]);
  requireControls(errors, threats, "fallback-downgrade-to-obo", [
    "capability-discovery",
    "mandatory-xaa-policy",
    "fallback-explicitness",
    "credential-audit"
  ]);
  requireControls(errors, threats, "actor-token-confusion", [
    "unsupported-actor-token-reject",
    "future-profile-required"
  ]);
  requireControls(errors, threats, "pop-dpop-downgrade", [
    "cnf-inspection",
    "dpop-proof-match",
    "downgrade-reject"
  ]);

  return { ok: errors.length === 0, errors };
}

export function findThreat(model, id) {
  return (model?.threats ?? []).find((threat) => threat.id === id);
}

function requireControls(errors, threats, id, controls) {
  const threat = threats.find((candidate) => candidate.id === id);
  if (!threat) {
    errors.push(`${id} threat is missing`);
    return;
  }
  for (const control of controls) {
    if (!threat.controls.includes(control)) {
      errors.push(`${id} must include ${control}`);
    }
  }
}
