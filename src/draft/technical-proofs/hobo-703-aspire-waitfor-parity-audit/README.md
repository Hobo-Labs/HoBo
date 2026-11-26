# HOBO-703 — Aspire WaitFor parity audit

GAP-027 remediation proof: the aspire.md HoBo-mapping tracker must not overclaim
health-gated `WaitFor`/`WaitForCompletion` parity when the orchestrator gates deploy
DAG edges on `resource.Provisioned` only.

This package reads the live docs and asserts:

- the `WaitFor` / `WaitForCompletion` tracker row is **◐** (not ✅);
- the row links the Plan 4 health-gated dependency iteration hook;
- `control-plane.md` documents the Provisioned-only vs health-gated gap.

Run:

```sh
pnpm --prefix src/draft/technical-proofs/hobo-703-aspire-waitfor-parity-audit test
```
