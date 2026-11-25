# HOBO-326 Flag Ruleset Sync Proof

This proof connects the M1 Harness sync slice to:

- [contracts-policy-flags.md](../../contracts-policy-flags.md#plan-29)
- [ADR-0044](../../adr/02-identity-security.md#adr-0044)
- [ADR-0050](../../adr/03-data-plane.md#adr-0050)
- [ADR-0083](../../adr/02-identity-security.md#adr-0083)

Executable artifact:

- [`src/draft/technical-proofs/flag-ruleset-sync-contract`](../../../../src/draft/technical-proofs/flag-ruleset-sync-contract)

Acceptance evidence:

- A `flag.Changed` appended to the log advances every subscribed evaluator to
  the latest ruleset `seq`.
- Evaluators expose current `seq` and a freshness label.
- Reconnect rebuilds from snapshot plus tail and matches a full replay.
- Disconnected evaluators serve last-known rulesets labeled stale.
- Out-of-order delivery is ignored and cannot regress an evaluator below its
  current `seq`.
- A backpressured evaluator does not stall delivery to healthy evaluators and
  catches up when drained.
- Evaluation remains local; there is no per-eval network call.

Scope boundary:

- No new evaluator implementation; this reuses the HOBO-319 built-in provider.
- No Streamer transport implementation; this proves the sync contract behind
  the transport seam.
- No cross-Camp consistency or partition-correctness hardening.
- No policy-gated flag flip runtime.
