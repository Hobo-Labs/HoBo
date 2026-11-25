# HOBO-319 Built-in Flag Store Proof

This proof connects the M1 built-in feature-flag store slice to:

- [contracts-policy-flags.md](../../contracts-policy-flags.md#plan-29)
- [docs/standards/openfeature.md](../../../standards/openfeature.md)
- [ADR-0036](../../adr/07-portability-extensibility.md#adr-0036)
- [ADR-0044](../../adr/02-identity-security.md#adr-0044)
- [ADR-0050](../../adr/03-data-plane.md#adr-0050)
- [ADR-0083](../../adr/02-identity-security.md#adr-0083)

Executable artifact:

- [`src/draft/technical-proofs/built-in-flag-store-contract`](../../../../src/draft/technical-proofs/built-in-flag-store-contract)

Acceptance evidence:

- `flag.Defined` and `flag.Changed` entries fold into a snapshot ruleset and an
  in-process provider.
- Boolean, string, number, and object evaluations use OpenFeature-shaped value
  and detail methods.
- Evaluation is a pure function of `(ruleset@seq, PrincipalRef context)`:
  replaying the same ruleset and context returns the same value, variant, and
  bucket.
- PrincipalRef targeting selects the intended segment and returns caller
  defaults for misses.
- Pinned `ruleset@seq` evaluation stays reproducible even after later events.
- Offline evaluation performs no network fetches.
- Per-flag buckets are stable across unrelated flag changes and across Node
  processes.
- Malformed ruleset entries and empty context fail safe to defaults.

Scope boundary:

- No SDK `ctx.flags.eval` or `useFlag` surface.
- No Streamer/ruleset sync transport.
- No provider adapters.
- No policy-gated flip implementation.
