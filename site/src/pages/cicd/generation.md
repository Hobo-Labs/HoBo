---
layout: ../../layouts/Docs.astro
title: Generation pipeline
description: "AI generation of providers and code under guardrails: sandbox, conformance, Registry certification, and patchability."
---

# Generation pipeline

HoBo treats AI generation as a **governed factory**, not a paste bin. Generated providers, patches, and app assistance run under the same contract, policy, and audit spine as human work.

## Loop (conceptual)

1. Request generation (`hobo generate` / MCP / Crew SWE·UX)
2. Produce candidate artifacts in a **sandbox lane**
3. Conformance + tests + SBOM/vuln gates
4. Human or policy approval when required
5. Registry certification / promote out of sandbox
6. Patchability preserved — generated code is not a black box seal

## Guardrails

- Prompt/tool safety → `guardrail.Blocked` + `policy.Decided`
- Capability Manifest prose is untrusted input (injection-aware)
- No ambient credentials in generation executors
- Training trajectories exclude sandbox poison by default

## What generation must not claim

- Silent production mutate without Gatekeeper
- Skipping conformance because “the model was confident”
- Embedding secrets into generated IaC or docs

## Related

[Progressive delivery](/HoBo/cicd/progressive-delivery/) · [SWE Crew](/HoBo/operations/swe/) · [Security](/HoBo/security/) · [Conformance testing](/HoBo/testing/conformance/)
