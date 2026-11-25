---
type: Reference
title: "AI Generation Safety Launch Posture"
description: "Source issue: HOBO-510."
tags: [hobo, design]
---

# AI Generation Safety Launch Posture

Source issue: HOBO-510.

Executable proof lives in
[`src/draft/exp-proofs/cx/ai-generation-launch-posture-contract`](../../src/draft/exp-proofs/cx/ai-generation-launch-posture-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-510-ai-generation-launch-posture`](./proofs/hobo-510-ai-generation-launch-posture/README.md).

## M0 Acceptance Record

HoBo already has architectural safety mechanisms for AI generation: contract-first inputs,
material sanitization, no-egress validation, guardrails, evals, policy gates, human approval,
and provenance. HOBO-510 turns those mechanisms into a customer-facing launch posture so beta,
GA, support, legal/privacy, and release owners know what can be claimed and what must be limited.

This is a launch-readiness contract, not an implementation of AI safety infrastructure.

## Supported Generation Inputs

| Input | Safety boundary | Customer-facing limit | Evidence |
|---|---|---|---|
| App intent and requirements | Treated as untrusted instruction material until policy and guardrails approve it. | Customers must review generated plans and code before governed launch. | [Plan 23](./generated-stack.md#plan-23) |
| WIT port and conformance contracts | Authoritative; natural-language material cannot override them. | Artifacts only claim ports/capabilities they pass through conformance. | [Plan 09](./generated-stack.md#plan-09) |
| Provider docs, OpenAPI, and Terraform material | Sanitized as untrusted material. | Material can guide generation but cannot grant capabilities. | [ADR-0010](./adr/03-data-plane.md#adr-0010) |
| Recorded traces and fixtures | Inherit data classification, redaction, retention, and opt-out boundaries. | Trace-based generation is limited to governed, redacted evidence. | [ADR-0099](./adr/03-data-plane.md#adr-0099) |
| `design.md` and UI intent | Constrained by design, typed materializations, and output guardrails. | Generated UI remains a reviewable proposal until UX/accessibility evidence accepts it. | [ADR-0056](./adr/03-data-plane.md#adr-0056) |

## Prohibited And Unsafe Uses

| Use case | Customer-facing posture | Route |
|---|---|---|
| Malware or credential theft | Refused. HoBo does not generate malware, credential theft, persistence, evasion, or exploit automation. | Abuse or prohibited use |
| Policy or guardrail bypass | Refused. HoBo does not bypass policy packs, guardrails, approvals, audit, or generated-code review. | Abuse or prohibited use |
| Unsafe regulated advice | Refused as a product claim. HoBo does not present generated content as medical, legal, financial, or safety-critical advice. | Unsafe or disallowed output |
| Privacy-invasive generation | Refused without policy approval. HoBo does not exfiltrate, deanonymize, train on, or reveal classified data. | Data leakage or residency risk |
| Impersonation or deceptive content | Refused. HoBo does not hide generated provenance or produce deceptive impersonation. | Unsafe or disallowed output |
| Unapproved live infrastructure change | Refused. Generation cannot directly mutate live infrastructure without conformance, safety reports, and required approval. | Generated vulnerability |

## Required Safety Controls

| Control | Beta posture | GA posture | Evidence |
|---|---|---|---|
| Material input sanitization | Required | Required | [`generation-material-sanitization-contract`](../../src/draft/technical-proofs/generation-material-sanitization-contract/README.md) |
| No-egress validation sandbox | Required | Required | [`no-egress-generation-sandbox-contract`](../../src/draft/technical-proofs/no-egress-generation-sandbox-contract/README.md) |
| Guardrail output policy gate | Required with known limitations | Required | [`guardrail-policy-gate-contract`](../../src/draft/technical-proofs/guardrail-policy-gate-contract/README.md) |
| Generated-code review and SBOM | Required with manual review | Required | HOBO-512 |
| Human approval for high-risk promotion | Required | Required | [`human-approval-generation-gate-contract`](../../src/draft/technical-proofs/human-approval-generation-gate-contract/README.md) |
| Red-team regression evidence | Seeded regression set | Required for launch claims | [Plan 46](./governance-planes.md#plan-46) |

## Finding Route Map

| Finding | Security verification | Legal/privacy | Support | Release cutline |
|---|---|---|---|---|
| Abuse or prohibited use | Owns refusal criteria and audit evidence. | Reviews public refusal and disclaimer language. | Receives customer-safe refusal explanation and escalation reason. | Missing refusal evidence blocks beta. |
| Unsafe or disallowed output | Verifies guardrail and red-team regression evidence. | Reviews limitation wording for unsafe content categories. | Receives incident category, blocked output class, and retry guidance. | GA requires guardrail coverage; beta can ship only with named limitations. |
| Data leakage or residency risk | Verifies classification, redaction, no-egress, and residency obligations. | Reviews PII, retention, opt-out, DPA/subprocessor, and region language. | Receives affected data class, remediation owner, and customer-notice source. | Unresolved leakage or residency bypass blocks launch. |
| Model provider failure | Verifies fail-closed behavior for unavailable, degraded, unapproved, or residency-ineligible providers. | Reviews hosted-model, subprocessor, and data-transfer assumptions. | Receives degraded-mode language and fallback availability. | GA needs supported-provider and fallback posture; beta can name provider limitations. |
| Generated vulnerability | Verifies conformance, generated-code safety gate, SBOM/vulnerability disposition, and human review. | Reviews disclosure, warranty, and generated-code limitation language. | Receives severity, workaround, patch, and customer-notice routing. | Known exploitable generated vulnerabilities block launch until fixed or explicitly out of scope. |

## Beta And GA Claims

Beta can claim that generation is contract-first and review-gated, and that some safety controls may
remain fixture-backed or manually reviewed. Beta cannot claim complete safety.

GA can claim that generation launch posture is backed by contract tests, no-egress validation,
guardrails, review evidence, and support routing. GA still cannot claim perfect correctness,
zero-risk generated code, no hallucinations, or external responsible-AI certification unless a
separate approved evidence program exists.

## Approved Public Claim Wording

- HoBo generation starts from contracts and must pass conformance, policy, and review gates before
  governed launch.
- Generation validation runs in a no-egress sandbox unless an explicit hosted-model grant is
  approved at a separate boundary.
- HoBo documents beta and GA limitations for generated outputs, safety controls, and review
  obligations.

Any stronger public claim needs a new reviewed claim record with architecture evidence, proof
evidence, limitation text, and a named review owner.

## Scope Out And Non-Goals

- Do not implement a guardrail engine here.
- Do not integrate a live model provider here.
- Do not create a responsible-AI attestation program here.
- Do not draft legal terms or privacy-policy language here.
- Do not build a production red-team service here.
- Do not build generation runtime or Registry implementation here.

## Authoritative Dependencies

- [Plan 23](./generated-stack.md#plan-23) owns generation pipeline and generated-stack mechanics.
- [Plan 46](./governance-planes.md#plan-46) owns AI safety and model-governance architecture.
- [ADR-0010](./adr/03-data-plane.md#adr-0010) owns contract-first generation and certification.
- [ADR-0023](./adr/02-identity-security.md#adr-0023) owns secure-by-default generation hardening.
- [ADR-0061](./adr/02-identity-security.md#adr-0061) owns sandboxed AI work and guardrail governance.
- [ADR-0099](./adr/03-data-plane.md#adr-0099) owns trajectory privacy.
- HOBO-512 owns SBOM, dependency vulnerability, and third-party notice evidence.
- HOBO-494 owns vulnerability disclosure and security launch-blocker process.

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Launch-posture fixture | Threat Model & Security Review | Contract test | Inputs, refusals, controls, routes, and scope-out are defined. |
| Public-claim register | Threat Model & Security Review / Legal | Contract test | Public wording is reviewed and evidence-backed. |
| Finding route map | Security / Support / Release | Design record | Safety findings do not disappear between architecture and launch. |
| Beta/GA blocker matrix | V1 Release Program & Cutline | Design record | Launch blockers, limitations, and follow-ups are explicit. |
| Scope guard | Threat Model & Security Review | Contract test | AI-safety platform implementation stays out of HOBO-510. |

## Follow-Up Gate

M1/M2/M3/M4 work may refine guardrail, red-team, provider, vulnerability, support, or legal evidence
only after this M0 posture is accepted. This branch records the posture and executable guard; it does
not create new implementation work.
