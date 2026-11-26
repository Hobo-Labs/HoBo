# @hobo/policy

Production policy decision model and built-in TypeScript engine. S3-07 (HOBO-633)
promotes agent guardrails (FR-022, BR-011): per-action-class approval gates,
`spendCapUsd` enforcement, and destroy protection with event-sourced
`policy.Decided` facts.

## Exports

- `@hobo/policy` — policy IR parsers plus agent guardrail evaluation.
- `@hobo/policy/guardrails` — agent guardrail surface only.

## Verification

```sh
pnpm --filter @hobo/policy test
pnpm --filter @hobo/policy test:contract:consumer
```
