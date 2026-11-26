---
type: Reference
title: "Contract-First Testing Strategy"
description: "Testing policy for deterministic validation without traditional full-stack E2E tests."
tags: [hobo, design, testing, contracts]
---

# Contract-First Testing Strategy

HoBo does not use traditional full-stack E2E tests. Service behavior is proven at the boundary with protobuf/CUE schema checks and Pact-style consumer/provider contracts. UI behavior is tested with deterministic mocks derived from those contracts or schema fixtures.

## Test lanes

| Lane | Command | Purpose |
|---|---|---|
| Unit | `pnpm test:unit` | Fast implementation tests for isolated logic. |
| Types | `pnpm test:types` | Type-level API expectations and compile-time checks. |
| Schema | `pnpm test:schema` | Protobuf/CUE/generated-contract compatibility. |
| Consumer contract | `pnpm test:contract:consumer` | Consumer expectations over actual client/data-access behavior. |
| Provider contract | `pnpm test:contract:provider` | Provider verification with mocked dependencies, never live downstream services. |
| DOM | `pnpm test:dom` | Rendered state and interaction state in a simulated DOM. |
| Component | `pnpm test:component` | Browser/component behavior, including Shadow DOM/focus/events when needed. |
| Behavior | `pnpm test:behavior` | Gherkin/Cucumber or Playwright-driven browser behavior with mocked service boundaries. |
| Visual | `pnpm test:visual` | Deterministic visual states. |
| Agent eval | `pnpm eval:agent:mock` | Mocked tools/models for default agent validation. |
| Live agent eval | `pnpm eval:agent:live` | Manual or release-gated live model/provider evaluation. |

## Non-goals

Do not add `test:e2e`, `e2e/`, full-stack Playwright suites, browser tests that call live downstream services, or UI mocks that drift from Pact/provider/schema fixtures.

## Targeted routing

`pnpm agent:check` inspects changed files and chooses the smallest lane that can prove the change:

- draft-local protobuf/CUE/Pact changes run the owning proof workspace with mocked boundaries;
- root protobuf/CUE changes run schema checks by default, with consumer/provider contract lanes reserved for explicit final/all validation;
- root/shared Pact artifacts mark contract scope, but broad consumer/provider sweeps require `--final` or `--all`;
- UI/component changes run DOM and component lanes;
- behavior specs run behavior tests with mocked service boundaries;
- stories/visual fixtures run visual tests;
- agent prompt/eval changes run mocked agent evals;
- root/package-manager changes add install, root-test, architecture, standards, and docs gates, with all-package build/test impact checks reserved for explicit `--build`, `--final`, or `--all` validation.

This keeps pre-commit and PR feedback fast while preserving contract-first coverage.

## Production packages

When the S0 toolchain lands `packages/*`, every production package that owns a service boundary keeps a local `contracts/` tree:

```text
packages/<name>/contracts/
  pact-inventory.md
  pacts/<boundary>.pact.json
  consumer/<boundary>.contract.test.ts
  provider/<boundary>.provider.test.ts
  provider/fixtures/*.ts
```

The `@hobo/contract-harness` package (zero runtime dependencies) supplies:

- `parsePactDocument` / `loadPactDirectory` — parse-don't-validate pact JSON against package-local CUE constraints
- `createMockProviderFromPact` — consumer-side in-process mocks
- `verifyPact` — provider verification with superset-tolerant response bodies
- `checkPactInventory` — inventory ↔ pact file drift gate

Root `pnpm test:contract:consumer` and `pnpm test:contract:provider` sweep draft proofs first, then `turbo run test:contract:* --filter "./packages/*"` for production packages.

`@hobo/contract-harness` lives in [`packages/contract-harness`](../../packages/contract-harness/README.md). The reference `core-contract-surface` boundary is in [`packages/core/contracts`](../../packages/core/contracts/pact-inventory.md), promoted from the epic-proof pact inventories under `src/draft/epic-proofs/*/contracts/`.

A draft POC mirror remains at [`src/draft/technical-proofs/pact-contract-harness`](../../src/draft/technical-proofs/pact-contract-harness/README.md) for isolated harness development.
