# HOBO-381 Flag Debt Auto-Cleanup Proof

This proof connects the M4 flag-debt lifecycle slice to:

- [contracts-policy-flags.md](../../contracts-policy-flags.md#plan-29)
- [ADR-0044](../../adr/02-identity-security.md#adr-0044)
- [ADR-0083](../../adr/02-identity-security.md#adr-0083)

Executable artifact:

- [`src/draft/technical-proofs/flag-debt-auto-cleanup-contract`](../../../../src/draft/technical-proofs/flag-debt-auto-cleanup-contract)

Acceptance evidence:

- Flags with no sampled `flag.Evaluated` events beyond the configured stale
  window are proposed for archival.
- Flags observed at terminal 100 percent or 0 percent values for the stale
  window are proposed for archival.
- Confirming a proposal emits `flag.Archived`, hides the flag from active
  listings, and keeps history replayable.
- Actively targeted flags are not marked stale, even when sampled values are
  currently constant.
- Sparse low-traffic flags are not archived purely because the sample count is
  low.
- Archived flags that remain referenced in live code surface those references
  and return a labeled last/default value instead of breaking evaluation.
- Archival is reversible and audit-preserving.

Scope boundary:

- No automated code deletion for dead branches.
- No policy gate for archive authorization.
- No evaluation engine implementation.
