import { isJsonString, isJsonObject } from "./json.js";
import { createHash } from "node:crypto";

export const BOOTSTRAP_DECISION_VERSION = "self-host-bootstrap-ordering/v1";

export const REQUIRED_FAILURE_SCENARIOS = Object.freeze([
  "seed-crash-after-provision",
  "handover-before-identity-ready",
  "operator-credential-expires-mid-apply",
  "airgap-no-egress",
  "double-bootstrap",
]);

export function createBootstrapPlan({
  attemptId,
  targetYard,
  targetCamp,
  operatorSubject,
  mode = "connected",
  offlineBundle,
  inBoundaryTrustRoot,
} = {}) {
  requireNonEmpty("attemptId", attemptId);
  requireNonEmpty("targetYard", targetYard);
  requireNonEmpty("targetCamp", targetCamp);
  requireNonEmpty("operatorSubject", operatorSubject);

  if (!["connected", "airgap"].includes(mode)) {
    throw new Error(`Unsupported bootstrap mode: ${mode}`);
  }

  if (mode === "airgap") {
    requireNonEmpty("offlineBundle.digest", offlineBundle?.digest);
    requireNonEmpty("inBoundaryTrustRoot", inBoundaryTrustRoot);
  }

  const seedLogHash = hashObject({
    attemptId,
    targetYard,
    targetCamp,
    operatorSubject,
    mode,
    offlineBundleDigest: offlineBundle?.digest ?? null,
  });

  return {
    version: BOOTSTRAP_DECISION_VERSION,
    attemptId,
    mode,
    target: { yard: targetYard, camp: targetCamp },
    egressAllowed: false,
    credential: {
      source: mode === "airgap" ? "in-boundary-bootstrap-trust-root" : "hobo-login-operator-oidc-or-svid",
      subject: operatorSubject,
      scope: `bootstrap-apply:${targetYard}:${targetCamp}`,
      singleUse: true,
      refreshable: false,
      auditedAs: "identity.SeedTokenUsed",
      retiredBy: "token.Revoked",
    },
    seedRuntime: {
      kind: "@hobo/runtime-local",
      eventStore: "sqlite",
      disposable: true,
    },
    offlineInputs:
      mode === "airgap"
        ? {
            bundleDigest: offlineBundle.digest,
            trustRoot: inBoundaryTrustRoot,
            hostedServicesAllowed: false,
          }
        : null,
    steps: [
      step("seed.started", "Start runtime-local seed Yard with local SQLite event store."),
      step("artifact.bundle-verified", "Verify SDK/Yard Bindle artifact before the first apply."),
      step("identity.SeedTokenUsed", "Use the operator bootstrap credential exactly once."),
      step("delta.Opened", "Open the first Deployment Delta against the empty target Yard."),
      step("resource.Provisioning", "Provision the real Yard resources through the selected provider/IaC adapter."),
      step("resource.Provisioned", "Record provisioned target resource state and outputs."),
      step("seedLog.Imported", "Import the seed log into the real Yard as immutable provenance.", {
        seedLogHash,
        replayMode: "read-only-provenance",
        liveCommandReplay: false,
      }),
      step("identity.Issued", "Require real Identity to issue a Yard control-plane token."),
      step("token.Revoked", "Retire the single-use operator bootstrap credential."),
      step("seed.Discarded", "Discard the local seed Yard after handover completes."),
    ],
  };
}

export function validateBootstrapPlan(plan) {
  if (plan?.version !== BOOTSTRAP_DECISION_VERSION) {
    return ["Plan version is not the accepted bootstrap ordering decision."];
  }

  const errors = [];

  if (plan.egressAllowed !== false) {
    errors.push("Bootstrap must not require public egress; connected mode may use operator login, but the plan stays egress-free.");
  }

  if (plan.credential?.singleUse !== true || plan.credential?.refreshable !== false) {
    errors.push("Operator bootstrap credential must be single-use and non-refreshable.");
  }

  if (plan.credential?.auditedAs !== "identity.SeedTokenUsed") {
    errors.push("Operator bootstrap credential use must be audited as identity.SeedTokenUsed.");
  }

  for (const [before, after] of [
    ["seed.started", "identity.SeedTokenUsed"],
    ["identity.SeedTokenUsed", "resource.Provisioning"],
    ["resource.Provisioned", "seedLog.Imported"],
    ["seedLog.Imported", "identity.Issued"],
    ["identity.Issued", "token.Revoked"],
    ["token.Revoked", "seed.Discarded"],
  ]) {
    requireOrder(plan, before, after, errors);
  }

  const importStep = findStep(plan, "seedLog.Imported");
  if (importStep?.data?.replayMode !== "read-only-provenance" || importStep?.data?.liveCommandReplay !== false) {
    errors.push("Seed log import must be immutable provenance, not live command replay.");
  }

  return errors;
}

export function handoverStatus(events) {
  const eventTypes = new Set(events);
  const required = ["resource.Provisioned", "seedLog.Imported", "identity.Issued"];
  const missing = required.filter((event) => !eventTypes.has(event));

  return {
    ready: missing.length === 0,
    missing,
    trigger: missing.length === 0 ? "real-identity-token-broker-ready" : null,
  };
}

export function classifyBootstrapAttempt(existingAttempt, incomingAttempt) {
  if (!existingAttempt) {
    return { action: "start", reason: "no-existing-bootstrap-attempt" };
  }

  if (existingAttempt === incomingAttempt) {
    return { action: "resume", reason: "same-bootstrap-attempt-id" };
  }

  return {
    action: "block",
    reason: "target-yard-already-has-a-different-bootstrap-attempt",
  };
}

export function failureRecoveryTable() {
  return [
    {
      id: "seed-crash-after-provision",
      recovery: "Resume the same attempt from the seed log plus observed target resource state; import only committed seed events.",
      invariant: "No second bootstrap attempt may create duplicate target resources.",
    },
    {
      id: "handover-before-identity-ready",
      recovery: "Keep seed authoritative until real Identity issues a Yard control-plane token.",
      invariant: "resource.Provisioned alone is not a handover trigger.",
    },
    {
      id: "operator-credential-expires-mid-apply",
      recovery: "Fail closed and require explicit operator re-login for the same attempt id.",
      invariant: "The seed never silently refreshes or swaps credentials.",
    },
    {
      id: "airgap-no-egress",
      recovery: "Require signed offline bundle and in-boundary trust root before seed start.",
      invariant: "No hosted IdP, public registry, public ACME, or hosted AI service is needed.",
    },
    {
      id: "double-bootstrap",
      recovery: "Resume only when the incoming attempt id matches the existing target attempt id; otherwise block.",
      invariant: "A target Yard has at most one bootstrap lineage.",
    },
  ];
}

function step(type, description, data = {}) {
  return { type, description, data };
}

function findStep(plan, type) {
  return plan.steps.find((candidate) => candidate.type === type);
}

function requireOrder(plan, before, after, errors) {
  const beforeIndex = plan.steps.findIndex((candidate) => candidate.type === before);
  const afterIndex = plan.steps.findIndex((candidate) => candidate.type === after);

  if (beforeIndex === -1 || afterIndex === -1 || beforeIndex >= afterIndex) {
    errors.push(`${before} must occur before ${after}.`);
  }
}

function hashObject(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortKeys(child)]),
    );
  }

  return value;
}

function requireNonEmpty(name, value) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${name} is required`);
  }
}
