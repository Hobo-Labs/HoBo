# HOBO-635 CredentialAudit Projection Proof

This executable proof pins the S3-09 `CredentialAudit` projection and NFR-018
never-compacted audit retention from
[Plan 05](../../reliability-observability-cost.md#plan-05),
[ADR-0023](../../adr/02-identity-security.md#adr-0023), and TR-052.

## Contract Surface

- `CredentialAuditView` folds `identity.*` and `token.*` streams into grant/use/revoke
  chains and per-principal timelines.
- Gateway and MCP query helpers expose security-review surfaces without live servers.
- Retention guards prove compliance streams older than the floor remain present and
  refuse compaction.

## Executable Checks

Run:

```bash
pnpm exec turbo run test --filter ./src/draft/technical-proofs/credential-audit-projection-contract
```

The checks prove deterministic projection rebuild, brokered-deploy trail reconstruction,
Gateway/MCP query parity, NFR-018 retention-floor preservation, and never-compact
enforcement on `token.*` / `resource.*` / `policy.*` streams.

## Maintenance

- 2026-07-02: architecture guard evidence expanded with full protobuf CUE coverage and
  parse-don't-validate derived-type notes in `ADR.md`.
