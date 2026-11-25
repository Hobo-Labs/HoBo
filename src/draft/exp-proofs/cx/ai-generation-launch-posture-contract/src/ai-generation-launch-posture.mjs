import { isJsonString, isJsonObject } from "./json.js";
export const REQUIRED_SUPPORTED_INPUTS = [
  "app-intent-and-requirements",
  "wit-port-and-conformance-contracts",
  "provider-docs-openapi-terraform",
  "recorded-traces-and-fixtures",
  "design-md-and-ui-intent",
];

export const REQUIRED_PROHIBITED_USE_CASES = [
  "malware-or-credential-theft",
  "policy-or-guardrail-bypass",
  "unsafe-regulated-advice",
  "privacy-invasive-generation",
  "impersonation-or-deceptive-content",
  "unapproved-live-infrastructure-change",
];

export const REQUIRED_SAFETY_CONTROLS = [
  "material-input-sanitization",
  "no-egress-validation-sandbox",
  "guardrail-output-policy-gate",
  "generated-code-review-and-sbom",
  "human-approval-for-high-risk-promotion",
  "red-team-regression-evidence",
];

export const REQUIRED_FINDING_ROUTES = [
  "abuse-or-prohibited-use",
  "unsafe-or-disallowed-output",
  "data-leakage-or-residency-risk",
  "model-provider-failure",
  "generated-vulnerability",
];

export const REQUIRED_PUBLIC_CLAIM_EVIDENCE = [
  "architectureCitation",
  "proofCitation",
  "knownLimitation",
  "reviewOwner",
];

const FORBIDDEN_SCOPE_PATTERNS = [
  /implement\s+(a\s+)?guardrail engine/i,
  /live model provider/i,
  /responsible-ai attestation program/i,
  /full ai safety platform/i,
  /legal terms/i,
  /production red-team service/i,
  /generation runtime/i,
  /registry implementation/i,
];

const OVERBROAD_PUBLIC_CLAIM_PATTERNS = [
  /fully safe/i,
  /guaranteed safe/i,
  /no hallucinations/i,
  /autonomous without review/i,
  /certified compliant/i,
  /zero risk/i,
];

export const AI_GENERATION_LAUNCH_POSTURE = {
  schema: "hobo.ai-generation-launch-posture/v1",
  issue: "HOBO-510",
  project: "Threat Model & Security Review",
  phase: "M0",
  goal:
    "Define the v1 customer-facing AI-generation safety posture without implementing the generation runtime, guardrail engines, model providers, legal text, or a full AI-safety platform.",
  supportedInputs: [
    {
      id: "app-intent-and-requirements",
      allowedForBeta: true,
      allowedForGa: true,
      safetyBoundary: "Intent and requirement text is treated as untrusted instruction material until policy and guardrails approve it.",
      customerFacingLimit: "HoBo can use intent to scaffold proposals, but customers must review generated plans and code before governed launch.",
      architectureEvidence: "docs/design/generated-stack.md#plan-23",
    },
    {
      id: "wit-port-and-conformance-contracts",
      allowedForBeta: true,
      allowedForGa: true,
      safetyBoundary: "WIT ports and conformance suites are authoritative and cannot be overridden by natural-language material.",
      customerFacingLimit: "Generated artifacts may only claim the ports and capabilities they pass through conformance.",
      architectureEvidence: "docs/design/generated-stack.md#plan-09",
    },
    {
      id: "provider-docs-openapi-terraform",
      allowedForBeta: true,
      allowedForGa: true,
      safetyBoundary: "Provider docs, OpenAPI descriptions, Terraform comments, and traces are sanitized as untrusted material.",
      customerFacingLimit: "Provider material can guide generation, but it cannot expand the authoritative contract or grant capabilities.",
      architectureEvidence: "docs/design/adr/03-data-plane.md#adr-0010",
    },
    {
      id: "recorded-traces-and-fixtures",
      allowedForBeta: true,
      allowedForGa: true,
      safetyBoundary: "Trace payloads inherit data classification, redaction, retention, and opt-out boundaries before generation use.",
      customerFacingLimit: "Trace-based generation is only as broad as the recorded, redacted, and governed evidence attached to the run.",
      architectureEvidence: "docs/design/adr/03-data-plane.md#adr-0099",
    },
    {
      id: "design-md-and-ui-intent",
      allowedForBeta: true,
      allowedForGa: true,
      safetyBoundary: "UI generation remains constrained by design.md, typed materializations, and output guardrails.",
      customerFacingLimit: "Generated UI is a reviewable proposal until accessibility, usability, and release evidence accept it.",
      architectureEvidence: "docs/design/adr/03-data-plane.md#adr-0056",
    },
  ],
  prohibitedUseCases: [
    {
      id: "malware-or-credential-theft",
      customerMessage: "HoBo refuses requests to create malware, credential theft, persistence, evasion, or exploit automation.",
      routeTo: "abuse-or-prohibited-use",
    },
    {
      id: "policy-or-guardrail-bypass",
      customerMessage: "HoBo refuses requests to bypass policy packs, guardrails, approvals, audit, or generated-code review.",
      routeTo: "abuse-or-prohibited-use",
    },
    {
      id: "unsafe-regulated-advice",
      customerMessage: "HoBo does not present generated content as medical, legal, financial, or safety-critical advice.",
      routeTo: "unsafe-or-disallowed-output",
    },
    {
      id: "privacy-invasive-generation",
      customerMessage: "HoBo refuses generation that exfiltrates, deanonymizes, trains on, or reveals classified customer data without policy approval.",
      routeTo: "data-leakage-or-residency-risk",
    },
    {
      id: "impersonation-or-deceptive-content",
      customerMessage: "HoBo refuses deceptive impersonation, hidden manipulation, or customer-facing claims that hide generated provenance.",
      routeTo: "unsafe-or-disallowed-output",
    },
    {
      id: "unapproved-live-infrastructure-change",
      customerMessage: "HoBo does not let generation directly mutate live infrastructure without conformance, safety reports, and required approval.",
      routeTo: "generated-vulnerability",
    },
  ],
  safetyControls: [
    {
      id: "material-input-sanitization",
      evidence: "src/draft/technical-proofs/generation-material-sanitization-contract/README.md",
      beta: "required",
      ga: "required",
      customerFacingLimit: "Untrusted material is escaped, refused, or treated only as hints.",
    },
    {
      id: "no-egress-validation-sandbox",
      evidence: "src/draft/technical-proofs/no-egress-generation-sandbox-contract/README.md",
      beta: "required",
      ga: "required",
      customerFacingLimit: "Validation runs do not receive ambient network access; hosted-model calls require explicit grants outside this validation boundary.",
    },
    {
      id: "guardrail-output-policy-gate",
      evidence: "src/draft/technical-proofs/guardrail-policy-gate-contract/README.md",
      beta: "required-with-known-limitations",
      ga: "required",
      customerFacingLimit: "Outputs are gated by policy and guardrail evidence; unsupported claims remain known limitations.",
    },
    {
      id: "generated-code-review-and-sbom",
      evidence: "HOBO-512",
      beta: "required-with-manual-review",
      ga: "required",
      customerFacingLimit: "Generated code needs review, dependency evidence, and vulnerability disposition before customer-ready claims.",
    },
    {
      id: "human-approval-for-high-risk-promotion",
      evidence: "src/draft/technical-proofs/human-approval-generation-gate-contract/README.md",
      beta: "required",
      ga: "required",
      customerFacingLimit: "Prod, high-risk, high-trust, destructive, or unknown-risk promotions require meaningful human approval.",
    },
    {
      id: "red-team-regression-evidence",
      evidence: "docs/design/governance-planes.md#plan-46",
      beta: "seeded-regression-set",
      ga: "required-for-launch-claims",
      customerFacingLimit: "Red-team findings become regression tests; absence of a run is a limitation, not a safety claim.",
    },
  ],
  findingRoutes: [
    {
      id: "abuse-or-prohibited-use",
      securityVerification: "Threat Model & Security Review owns refusal criteria and audit evidence.",
      legalPrivacy: "V1 Legal, Privacy & Terms Readiness reviews public refusal/disclaimer language.",
      support: "V1 Launch Support Desk & Escalation receives customer-safe refusal explanation and escalation reason.",
      releaseCutline: "V1 Release Program & Cutline treats missing refusal evidence as a beta blocker.",
    },
    {
      id: "unsafe-or-disallowed-output",
      securityVerification: "Guardrail contract evidence and red-team regression results must be attached.",
      legalPrivacy: "Legal/privacy determines customer-facing limitation wording for unsafe content categories.",
      support: "Support receives incident category, blocked output class, and retry/escalation guidance.",
      releaseCutline: "GA requires guardrail coverage evidence; beta may ship only with named known limitations.",
    },
    {
      id: "data-leakage-or-residency-risk",
      securityVerification: "Security verifies data classification, redaction, no-egress, and residency obligations.",
      legalPrivacy: "Legal/privacy reviews PII, DPA/subprocessor, retention, opt-out, and region limitation language.",
      support: "Support receives affected data class, remediation owner, and customer-notice decision source.",
      releaseCutline: "Any unresolved data-leakage or residency bypass is a launch blocker.",
    },
    {
      id: "model-provider-failure",
      securityVerification: "Security verifies fail-closed behavior for unavailable, degraded, unapproved, or residency-ineligible model providers.",
      legalPrivacy: "Legal/privacy reviews hosted-model, subprocessor, and data-transfer assumptions.",
      support: "Support receives degraded-mode language and whether local/in-boundary fallback is available.",
      releaseCutline: "GA needs supported-provider and fallback posture; beta can name provider limitations.",
    },
    {
      id: "generated-vulnerability",
      securityVerification: "Security verifies conformance, generated-code safety gate, SBOM/vulnerability disposition, and required human review.",
      legalPrivacy: "Legal/privacy reviews disclosure, warranty, and customer-facing generated-code limitation language.",
      support: "Support receives vulnerability severity, workaround, patch, and customer-notice routing.",
      releaseCutline: "Known exploitable generated vulnerabilities are launch blockers until fixed or explicitly out of scope.",
    },
  ],
  releasePosture: {
    beta: {
      allowedClaims: [
        "Generation is contract-first and review-gated.",
        "Generated artifacts require conformance, safety, and human approval evidence before governed launch.",
        "Some safety controls may be fixture-backed or manually reviewed during beta.",
      ],
      requiredEvidence: [
        "supported-input-record",
        "prohibited-use-refusal-table",
        "known-limitations-list",
        "security-support-route-map",
      ],
      blockers: [
        "no prohibited-use refusal record",
        "no data-leakage route",
        "public claim lacks architecture evidence",
      ],
    },
    ga: {
      allowedClaims: [
        "Generation launch posture is backed by contract tests, no-egress validation, guardrails, review evidence, and support routing.",
        "Public AI-safety claims are tied to named proof and limitation records.",
      ],
      requiredEvidence: [
        "guardrail-coverage-evidence",
        "red-team-regression-evidence",
        "sbom-vulnerability-evidence",
        "legal-privacy-reviewed-disclaimers",
        "support-runbook-routing",
      ],
      blockers: [
        "missing guardrail evidence for customer-facing output",
        "unresolved data-leakage or model-provider residency risk",
        "unreviewed generated-code vulnerability disposition",
      ],
    },
  },
  publicClaims: [
    {
      id: "contract-first-generation",
      approvedText: "HoBo generation starts from contracts and must pass conformance, policy, and review gates before governed launch.",
      architectureCitation: "docs/design/generated-stack.md#plan-23",
      proofCitation: "src/draft/technical-proofs/generation-safety-gate-contract/README.md",
      knownLimitation: "This is a launch-posture record, not a guarantee that every generated artifact is correct.",
      reviewOwner: "Threat Model & Security Review",
    },
    {
      id: "sandboxed-validation",
      approvedText: "Generation validation runs in a no-egress sandbox unless an explicit hosted-model grant is approved at a separate boundary.",
      architectureCitation: "docs/design/adr/02-identity-security.md#adr-0061",
      proofCitation: "src/draft/technical-proofs/no-egress-generation-sandbox-contract/README.md",
      knownLimitation: "Hosted model calls require explicit residency-checked egress grants and cannot be implied by the sandbox proof.",
      reviewOwner: "Threat Model & Security Review",
    },
    {
      id: "customer-facing-limitations",
      approvedText: "HoBo documents beta and GA limitations for generated outputs, safety controls, and review obligations.",
      architectureCitation: "docs/design/governance-planes.md#plan-46",
      proofCitation: "docs/design/ai-generation-launch-posture.md",
      knownLimitation: "HoBo exports responsible-AI facts; it does not run an external attestation program in this issue.",
      reviewOwner: "V1 Legal, Privacy & Terms Readiness",
    },
  ],
  scopeOut: [
    "No guardrail engine implementation.",
    "No live model provider integration.",
    "No responsible-AI attestation program.",
    "No legal terms or privacy-policy text.",
    "No production red-team service.",
    "No generation runtime or Registry implementation.",
  ],
};

export function validateLaunchPosture(posture) {
  const errors = [];

  if (!posture || !isJsonObject(posture)) {
    return { ok: false, errors: ["launch posture record is required"] };
  }

  if (posture.schema !== "hobo.ai-generation-launch-posture/v1") {
    errors.push("schema must be hobo.ai-generation-launch-posture/v1");
  }
  if (posture.issue !== "HOBO-510") {
    errors.push("issue must be HOBO-510");
  }
  if (posture.phase !== "M0") {
    errors.push("phase must be M0");
  }

  requireIds(posture.supportedInputs, REQUIRED_SUPPORTED_INPUTS, "supportedInputs", errors);
  requireIds(posture.prohibitedUseCases, REQUIRED_PROHIBITED_USE_CASES, "prohibitedUseCases", errors);
  requireIds(posture.safetyControls, REQUIRED_SAFETY_CONTROLS, "safetyControls", errors);
  requireIds(posture.findingRoutes, REQUIRED_FINDING_ROUTES, "findingRoutes", errors);

  for (const input of posture.supportedInputs ?? []) {
    for (const field of ["safetyBoundary", "customerFacingLimit", "architectureEvidence"]) {
      if (!input[field]) {
        errors.push(`${input.id ?? "<missing>"} missing ${field}`);
      }
    }
  }

  for (const useCase of posture.prohibitedUseCases ?? []) {
    if (!useCase.customerMessage || !REQUIRED_FINDING_ROUTES.includes(useCase.routeTo)) {
      errors.push(`${useCase.id ?? "<missing>"} must name customerMessage and valid routeTo`);
    }
  }

  for (const control of posture.safetyControls ?? []) {
    for (const field of ["evidence", "beta", "ga", "customerFacingLimit"]) {
      if (!control[field]) {
        errors.push(`${control.id ?? "<missing>"} missing ${field}`);
      }
    }
  }

  for (const route of posture.findingRoutes ?? []) {
    for (const lane of ["securityVerification", "legalPrivacy", "support", "releaseCutline"]) {
      if (!route[lane]) {
        errors.push(`${route.id ?? "<missing>"} missing ${lane}`);
      }
    }
  }

  for (const phase of ["beta", "ga"]) {
    const record = posture.releasePosture?.[phase];
    for (const section of ["allowedClaims", "requiredEvidence", "blockers"]) {
      if (!Array.isArray(record?.[section]) || record[section].length === 0) {
        errors.push(`${phase}.${section} must be non-empty`);
      }
    }
  }

  for (const claim of posture.publicClaims ?? []) {
    for (const field of REQUIRED_PUBLIC_CLAIM_EVIDENCE) {
      if (!claim[field]) {
        errors.push(`${claim.id ?? "<missing>"} missing ${field}`);
      }
    }
    const review = reviewPublicClaim(claim.approvedText, posture);
    if (!review.ok) {
      errors.push(`${claim.id ?? "<missing>"} approvedText failed review: ${review.errors.join("; ")}`);
    }
  }

  for (const entry of posture.scopeOut ?? []) {
    if (!entry) {
      errors.push("scopeOut entries must be non-empty");
    }
  }

  return { ok: errors.length === 0, errors };
}

export function routeGenerationFinding(findingType, posture = AI_GENERATION_LAUNCH_POSTURE) {
  const route = (posture.findingRoutes ?? []).find((candidate) => candidate.id === findingType);

  if (!route) {
    return {
      ok: false,
      errors: [`unknown generation finding route: ${findingType}`],
    };
  }

  return {
    ok: true,
    route,
    requiresLaunchDisposition: true,
  };
}

export function reviewPublicClaim(text, posture = AI_GENERATION_LAUNCH_POSTURE) {
  const errors = [];

  if (!text || !isJsonString(text)) {
    return { ok: false, errors: ["public claim text is required"] };
  }

  if (OVERBROAD_PUBLIC_CLAIM_PATTERNS.some((pattern) => pattern.test(text))) {
    errors.push("public claim overstates safety beyond approved architecture evidence");
  }

  const approved = (posture.publicClaims ?? []).some((claim) => claim.approvedText === text);
  if (!approved) {
    errors.push("public claim must match an approved reviewed claim");
  }

  return { ok: errors.length === 0, errors };
}

export function classifyLaunchGap(gap) {
  if (!gap || !isJsonObject(gap)) {
    return { ok: false, errors: ["launch gap is required"] };
  }

  const allowed = ["launch-blocker", "known-limitation", "post-v1-follow-up"];
  if (!allowed.includes(gap.disposition)) {
    return {
      ok: false,
      errors: [`disposition must be one of ${allowed.join(", ")}`],
    };
  }

  if (gap.disposition === "known-limitation" && !gap.customerFacingText) {
    return {
      ok: false,
      errors: ["known limitations require customerFacingText"],
    };
  }

  if (gap.disposition === "post-v1-follow-up" && !gap.followUpOwner) {
    return {
      ok: false,
      errors: ["post-v1 follow-ups require followUpOwner"],
    };
  }

  return { ok: true, disposition: gap.disposition };
}

export function rejectScopeCreep(proposedWork) {
  const text = Array.isArray(proposedWork) ? proposedWork.join("\n") : String(proposedWork ?? "");
  const matches = FORBIDDEN_SCOPE_PATTERNS.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);

  return {
    ok: matches.length === 0,
    errors: matches.map((pattern) => `scope creep matches forbidden launch-posture boundary: ${pattern}`),
  };
}

function requireIds(records, requiredIds, fieldName, errors) {
  const ids = new Set((records ?? []).map((record) => record.id));
  for (const id of requiredIds) {
    if (!ids.has(id)) {
      errors.push(`${fieldName} missing ${id}`);
    }
  }
}
