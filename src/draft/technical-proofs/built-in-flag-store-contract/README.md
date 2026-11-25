# Built-in Flag Store Contract

Executable POC for HOBO-319. It proves the default `hobo:feature-flag`
implementation boundary without adding SDK helpers, ruleset sync transport,
provider adapters, or policy-gated flip runtime.

The package folds event-sourced `flag.*` entries from
`src/draft/technical-proofs/flag-event-contract`, snapshots a ruleset at a requested `seq`, and
exposes an OpenFeature-shaped in-process provider for boolean, string, number,
and object flags.

Acceptance proof lives in
[`test/built-in-flag-store.test.ts`](./test/built-in-flag-store.test.ts):

- fixed `(ruleset@seq, ctx.user)` evaluations are deterministic;
- targeting rules select the expected PrincipalRef segment;
- pinned `ruleset@seq` evaluations remain reproducible after later changes;
- evaluation is offline and performs no network fetches;
- per-flag buckets are stable when unrelated flags change and across Node
  processes;
- malformed ruleset entries fail safe to the caller default;
- empty context returns the default instead of throwing.

Run:

```text
npm.cmd --prefix src\draft\technical-proofs\built-in-flag-store-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Built In Flag Store Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
