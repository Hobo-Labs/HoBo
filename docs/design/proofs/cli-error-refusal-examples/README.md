---
type: Reference
title: "CLI Error Refusal Examples Proof"
description: "Source issue: HOBO-558."
tags: [hobo, design]
---

# CLI Error Refusal Examples Proof

HOBO-558 records the customer-safe terminal, JSON, and MCP refusal examples that later CLI/API/SDK,
dashboard, support, docs, and launch proof packages must reuse.

## Evidence

- Proof package: [`../../../../src/draft/exp-proofs/dx/cli-error-refusal-examples/README.md`](../../../../src/draft/exp-proofs/dx/cli-error-refusal-examples/README.md)
- Source designs:
  - [`developer-experience.md#plan-07`](../../developer-experience.md#plan-07)
  - [`cli-spec.md`](../../cli-spec.md)
  - [`sdk-contracts.md`](../../sdk-contracts.md)
  - [`contracts-policy-flags.md#plan-29`](../../contracts-policy-flags.md#plan-29)
  - [`platform-engineering.md#plan-25`](../../platform-engineering.md#plan-25)
  - [`operators-sre.md#plan-40`](../../operators-sre.md#plan-40)

## Acceptance Mapping

- The catalog covers missing dependency, credential/auth failure, policy denial, contract
  incompatibility, stale projection, unknown evidence, non-reactive sink, provider capability
  partial/none, destructive migration blocked, and support bundle handoff.
- Every example carries human terminal copy, JSON output, MCP tool result shape, exit code, proof
  mode, fixture id, accessibility notes, and customer-safe wording.
- Fixture ids are accepted HOBO-572 `dx.lifecycle.*` facts from the deterministic
  resource lifecycle fixture corpus, with fixture proof mode repeated in JSON and
  MCP metadata.
- Non-live examples fail closed and avoid live-success claims when proof mode is simulated or
  reference fixture.
- Scope guards reject production error handlers, live auth/provider checks, support ticket
  automation, and dashboard copy before CLI/API/SDK envelopes are accepted.

## Proof Command

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\cli-error-refusal-examples test
```

## Scope Boundary

This proof does not implement production error handling, live auth checks, provider checks, support
automation, dashboard copy, or live customer success claims.
