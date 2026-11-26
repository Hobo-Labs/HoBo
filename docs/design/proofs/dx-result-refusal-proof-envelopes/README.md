---
type: Reference
title: "HOBO-571 DX Result Refusal Proof Envelopes"
description: "Source issue: HOBO-571."
tags: [hobo, design]
---

# HOBO-571 DX Result Refusal Proof Envelopes

This proof records the M1 shared envelope shape for DX-first API, SDK, CLI,
and MCP resource lifecycle examples.

## Requirements Source

- Linear: HOBO-571
- Parent: HOBO-566 DX backbone
- Design records:
  - [Developer Experience](../../developer-experience.md)
  - [SDK / API Design](../../sdk-api.md)
  - [Control Plane](../../control-plane.md)
  - [Platform Engineering](../../platform-engineering.md)
  - [Data Plane](../../data-plane.md)
- Proof package:
  [`dx-result-refusal-proof-envelopes`](../../../../src/draft/exp-proofs/dx/dx-result-refusal-proof-envelopes/README.md)

## Acceptance Evidence

- The catalog defines success, plan warning, Gatekeeper denial, approval
  required, contract incompatibility, stale projection, unknown evidence,
  non-reactive sink, migration blocked, rollback available, and support
  handoff.
- Every envelope carries human copy, machine code, remediation, proof mode,
  fixture id, trace id, correlation id, redaction class, accessibility notes,
  and copy notes.
- SDK, CLI JSON, and MCP tool-result examples are generated from the same
  parsed record, and warning/handoff outcomes carry the same non-error
  semantics on every surface.
- Deterministic fixtures separate happy paths from fail-closed paths and hash
  stably with a carried digest for downstream examples.
- Optimistic live or production success claims are rejected without accepted
  fixture evidence.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\dx-result-refusal-proof-envelopes test
pnpm.cmd run docs:design-lint
pnpm.cmd run architecture:guard
git diff --check
```
