# HoBo Policy IR contract POC

HOBO-91 pins the v1 request and decision shape used by every policy gate:
agent actions, deploy promotion, runtime authorization, live-fix, training, and
control-plane governance.

This POC defines:

- `DecisionRequest` validation for `subject`, `action`, `resource`, `phase`,
  and arbitrary JSON `context`.
- `Decision` validation for rich effects, durable obligations, and replay
  evidence.
- Canonical JSON hashing for `evidence.inputHash`, independent of object field
  order.
- `policy.Decided` event payload creation.
- JSON schema and WIT-record-style decision encoding.
- A typed v0-to-v1 request migration seam.

Scope intentionally stops at the IR. It does not implement a policy engine,
obligation execution, deny-ceiling algebra, or contract IR.

The public type surface is exercised by a `tsc --noEmit` type-test
(`test/types/policy-ir-usage.ts`): `Decision`, `DecisionRequest`, `Effect`,
and `Phase` are exported as precise unions (e.g. `Effect = typeof EFFECTS[number]`)
and evidence hashes are typed as `` `sha256:${string}` `` so mismatches fail at
compile time. Run the suite with `pnpm --filter @hobo-draft/policy-ir-contract test`
(Vitest, preceded by `npm run typecheck`).


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Policy Ir Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
