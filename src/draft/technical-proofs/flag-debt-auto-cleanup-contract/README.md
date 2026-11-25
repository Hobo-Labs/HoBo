# Flag Debt Auto-Cleanup Contract

Executable POC for HOBO-381. It proves stale feature-flag detection and
non-destructive archival without implementing code deletion, archive policy
authorization, or the evaluation engine.

The package consumes the existing `flag.*` event shape from
`src/draft/technical-proofs/flag-event-contract` and adds the flag-debt lifecycle contract:

- propose archival for flags with no sampled evaluations after the stale window;
- propose archival for flags pinned at terminal values for the stale window;
- never propose active targeted flags or sparse low-traffic flags on count alone;
- confirm archival by emitting `flag.Archived`;
- hide archived flags from active listings while retaining replayable history;
- surface live code references for archived flags instead of silently breaking;
- restore archived flags with a reversible `flag.Archived` event where
  `data.archived` is `false`.

Acceptance proof lives in
[`test/flag-debt-auto-cleanup.test.ts`](./test/flag-debt-auto-cleanup.test.ts).

Run:

```text
npm.cmd --prefix src\draft\technical-proofs\flag-debt-auto-cleanup-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Flag Debt Auto Cleanup Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
