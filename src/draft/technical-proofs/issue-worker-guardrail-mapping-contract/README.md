# Issue-Worker Guardrail Mapping Contract POC

Independent POC for HOBO-702 (REM-032 / GAP-024). Pins the mapping between
HoBo's agent-native safety model ([BR-011](../../../docs/archive/requirements/requirements.md),
[Plan 06](../../../docs/design/ai-native-agent-auth.md#plan-06)) and the
[`docs/automations/hobo-issue-worker.md`](../../../docs/automations/hobo-issue-worker.md)
automation spec.

## Contract Surface

- `assertIssueWorkerGuardrailMapping(docText)` — parses automation doc text and
  fails closed when required BR-011 / Plan 06 guardrail citations or mapping
  rows are missing.
- `issueWorkerGuardrailMappingRecord()` — canonical mapping record derived from
  the automation doc contract.

## Scope Boundaries

Included:

- Executable proof that the automation doc cites BR-011, Plan 06, FR-022,
  Plan 29, and ADR-0094.
- Mapping table rows for high-risk gating, quota analog, destroy protection,
  tool-contract bounds, policy obligations, and SafetyEnvelope.

Excluded:

- Runtime enforcement of issue-worker automation (Cursor/Codex harness).
- Changes to `docs/design/` files.

## Verification

```bash
pnpm --prefix src/draft/technical-proofs/issue-worker-guardrail-mapping-contract test
```
