---
type: Reference
title: "HOBO-510 AI Generation Launch Posture Proof"
description: "Source issue: HOBO-510."
tags: [hobo, design]
---

# HOBO-510 AI Generation Launch Posture Proof

HOBO-510 is proven by the focused M0 contract at
[`src/draft/exp-proofs/cx/ai-generation-launch-posture-contract`](../../../../src/draft/exp-proofs/cx/ai-generation-launch-posture-contract/README.md)
and the durable scope record at
[`ai-generation-launch-posture.md`](../../ai-generation-launch-posture.md).

## Acceptance Evidence

- Supported generation inputs are explicit and tied to safety boundaries, customer-facing limits,
  and architecture evidence.
- Prohibited use cases cover abuse, policy bypass, unsafe regulated advice, privacy-invasive
  generation, impersonation, and unapproved live infra change.
- Required safety controls name material sanitization, no-egress validation, output guardrails,
  generated-code review/SBOM, human approval, and red-team regression evidence.
- Abuse, unsafe output, data leakage, model/provider failure, and generated-vulnerability findings
  route to security verification, legal/privacy, support, and release cutline owners.
- Beta vs GA claims, blockers, required evidence, known limitations, and post-v1 follow-up posture
  are recorded.
- Public claims require exact reviewed wording plus architecture evidence, proof evidence, known
  limitation text, and a review owner.

## Negative Coverage

- Overbroad public claims such as fully safe, certified compliant, no hallucinations, or zero risk
  are rejected.
- Known limitations and post-v1 follow-ups require customer-facing or owner metadata.
- Scope validation rejects guardrail-engine, live-model-provider, legal-terms, responsible-AI
  attestation, production red-team service, and generation-runtime expansion.
- Removing no-egress safety control or data-leakage route makes validation fail closed.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\ai-generation-launch-posture-contract test
```
