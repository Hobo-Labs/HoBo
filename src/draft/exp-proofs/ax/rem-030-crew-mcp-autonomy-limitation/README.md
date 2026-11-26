# REM-030 Crew/MCP Autonomy Known-Limitation Proof

HOBO-697 proof that GAP-022 is closed: the customer-facing known-limitations
register documents Crew/MCP write autonomy as policy-gated, not fully
unsupervised.

## Acceptance (HOBO-697)

1. `docs/design/known-limitations-register.md` contains at least one Crew/MCP
   limitation row in the Initial V1 Entries table.
2. The executable register contract stays in sync with the design doc row.

## Verification

```bash
pnpm --prefix src/draft/exp-proofs/ax/rem-030-crew-mcp-autonomy-limitation test
pnpm exec oxlint src/draft/exp-proofs/ax/rem-030-crew-mcp-autonomy-limitation --deny-warnings
pnpm --prefix src/draft/exp-proofs/cx/known-limitations-register-contract test
```
