# Dapr Parity Anchor Audit

HOBO-699 pins an executable guard for `docs/competitors/dapr.md` Bindings and
Distributed lock parity rows. The audit fails closed when either feature claims
designed-at-parity (✅) without a design anchor, or when the rows lose their 🔜
iteration-hook status and honest gap wording.

## Contract

[`src/dapr-parity-anchor-audit.ts`](./src/dapr-parity-anchor-audit.ts) loads the
live competitor doc, extracts the Bindings and Distributed lock HoBo-mapping
rows, and reports violations through `assertNoParityOverclaim`.

## Verification

```bash
pnpm --prefix src/draft/exp-proofs/dx/dapr-parity-anchor-audit test
```

The tests prove:

- Bindings and Distributed lock stay 🔜 with relative design anchors;
- neither feature rides a bundled ✅ "near 1:1" row;
- fixture rows that claim ✅ without anchors are rejected.

## Design evidence

Remediation spec: [`GAPS.md`](../../../../../GAPS.md) § `REM-033 (for GAP-025)`.
