---
type: Reference
title: "HOBO-651 WIT Port Stub Contract Proof"
description: "Source issue: HOBO-651."
tags: [hobo, design]
---

# HOBO-651 WIT Port Stub Contract Proof

Branch evidence for S5-06 `stub()` recording typed stubs behind any WIT port.

## Branch Evidence

- Issue: HOBO-651
- Design refs: [Plan 23](../../generated-stack.md#plan-23), [ADR-0076](../../adr/02-identity-security.md#adr-0076)
- Draft package:
  [`src/draft/technical-proofs/wit-port-stub-contract`](../../../../src/draft/technical-proofs/wit-port-stub-contract/README.md)
- Focused gate:
  `pnpm --prefix src/draft/technical-proofs/wit-port-stub-contract test`

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Reference app runs with one port stubbed | `reference checkout app runs end-to-end with payments port stubbed` |
| Calls appear as events | `stubbed calls emit stub.Recorded and link.Called events` |
| Recorded trace replays deterministically through S1-12 harness | `recorded trace exports for Camp event store and replays deterministically` |

## Adversarial Coverage

| Adversarial case | Proof |
|---|---|
| Schema-invalid responses rejected | `schema-invalid stub responses fail closed at the boundary` |
| Replay divergence fails closed | `replay harness rejects nondeterministic adapter output` |
| Unlinked port fails typed no-route | `unlinked imports fail with typed no-route instead of panicking` |
| Architecture artifacts pinned | `architecture artifacts pin protobuf, CUE, Pact, and ADR boundaries` |
