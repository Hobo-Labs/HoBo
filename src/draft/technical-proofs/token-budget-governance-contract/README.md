# Token Budget Governance Contract POC

Independent POC for HOBO-695 / GAP-021. Pins the pre-inference **`TokenBudget`**
gate seam between a seq-pinned `MeteringView` and the policy plane without
implementing the policy engine, MeteringView projector, model runtime, or
OpenInference span ingestion.

## Contract Surface

- `evaluateInferenceTokenBudget({ request, meteringView, policies, approval, estimatedTokens })`
  consumes a policy `DecisionRequest`, a seq-pinned `MeteringView` snapshot with
  inference-token counters, and the call's estimated input/output token counts.
- `TokenBudget` policies carry scoped soft/hard limits for `inputTokens`,
  `outputTokens`, and `totalTokens` over `per-run`, `daily`, or `monthly`
  periods.
- Hard threshold crossing denies the inference gate; soft crossing emits a warn
  obligation without blocking.
- Decisions return a policy IR decision plus auditable `policy.Decided` and
  `inference.BudgetGateEvaluated` events.
- **Not** auth `token.*` credential grants — inference counters are a separate
  metering dimension family.

## Scope Boundaries

Included:

- Pre-inference gate evaluation before model invocation.
- Soft limit warn obligations and hard limit denies.
- Missing scoped inference-token counters fail closed for spend-incurring calls.
- Agent scope-evasion guard (splitting across sub-scopes does not bypass parent
  budget).
- Approval routing for policies that require human sign-off on hard crossings.

Excluded:

- Policy-engine implementation or `TokenBudget` authoring UI.
- MeteringView projection from OpenInference spans.
- Streaming mid-call truncation/degrade enforcement.
- USD spend-cap logic (see `budget-quota-policy-contract`).

## Verification

```bash
pnpm --prefix src/draft/technical-proofs/token-budget-governance-contract test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
