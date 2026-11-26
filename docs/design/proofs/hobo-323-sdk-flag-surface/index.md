# HOBO-323 SDK Flag Surface Proof

This proof connects the M1 SDK feature-flag surface slice to:

- [contracts-policy-flags.md](../../contracts-policy-flags.md#plan-29)
- [ADR-0044](../../adr/02-identity-security.md#adr-0044)
- [ADR-0050](../../adr/03-data-plane.md#adr-0050)
- [ADR-0083](../../adr/02-identity-security.md#adr-0083)

Executable artifact:

- [`src/draft/technical-proofs/sdk-flag-surface-contract`](../../../../src/draft/technical-proofs/sdk-flag-surface-contract)

Acceptance evidence:

- Server `ctx.flags.eval(flag, context?)` returns declaration-typed values from
  the deterministic in-process flag provider.
- Server request context is dynamic per call; empty request context falls back to
  global/default evaluation instead of crashing.
- Client `useFlag(flag)` reads a static setContext-style client context and
  updates subscribers when `flag.Changed` entries are appended.
- TypeScript declarations carry each flag declaration's value type to
  `ctx.flags.eval` and `useFlag` call sites.
- Archived flags return caller defaults and include deprecation evidence in
  evaluation details.
- Rapid consecutive flips notify subscribers once per append batch and coalesce
  to the latest value.

Scope boundary:

- No evaluation engine internals beyond consuming the built-in provider from
  HOBO-319.
- No Streamer/ruleset sync transport.
- No Reactor implementation.
- No policy gating or flip approval workflow.
