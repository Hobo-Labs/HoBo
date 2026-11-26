import {
  REQUIRED_CHECK_KINDS,
  createDomainValidationGate,
  type CheckKind,
  type DomainValidationRequest,
  type ValidationCheckResult,
} from "@hobo/draft-domain-validation-gate-contract";

const checkKinds: readonly CheckKind[] = REQUIRED_CHECK_KINDS;
const request: DomainValidationRequest = {
  domain: "shop.example",
  changeId: "change-typed",
  camp: "prod-us",
  stage: () => Promise.resolve({ event: { type: "domain.RoutingChanged" } }),
  liveZone: {
    assertUnchanged(label: string) {
      void label;
    },
  },
};

const pass = async (): Promise<ValidationCheckResult> => ({
  ok: true,
  evidence: { source: "typed-fixture" },
});

const gate = createDomainValidationGate({
  checks: {
    "multi-vantage-resolve": pass,
    "ttl-aware-propagation": pass,
    "acme-challenge": pass,
    "endpoint-health": pass,
  },
});

const outcome = await gate.validate(request);

if (outcome.status === "failed") {
  const failedCheck: CheckKind | "shadow-stage" | "live-zone-invariant" | undefined =
    outcome.failedCheck;
  void failedCheck;
}

// @ts-expect-error validation check kinds are closed over the four required gate checks.
const unsupported: CheckKind = "cert-issued";

// @ts-expect-error validation requests must stage through the shadow DNS path.
const missingStage: DomainValidationRequest = {
  domain: "shop.example",
  changeId: "bad",
  camp: "prod-us",
};

void [unsupported, missingStage];

void [checkKinds, outcome];
