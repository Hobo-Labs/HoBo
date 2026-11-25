# SDK Flag Surface Contract

Executable POC for HOBO-323. It proves the SDK consumption boundary for feature
flags without adding the evaluation engine internals, ruleset sync transport,
Reactor implementation, or policy-gated flip runtime.

The package wraps the event-sourced flag log and built-in in-process provider
from the lower-level flag contracts with:

- server `ctx.flags.eval(flag, context?)`, `details`, and `bucket` helpers;
- client `useFlag(flag)` probes with static client context and subscription
  updates;
- declaration-driven TypeScript value inference from flag refs to call sites.

Acceptance proof lives in
[`test/sdk-flag-surface.test.ts`](./test/sdk-flag-surface.test.ts):

- `ctx.flags.eval(newCheckout)` returns the declaration-typed deterministic
  value for the request context;
- `useFlag(newCheckout)` returns the current value and rerenders on
  `flag.Changed`;
- declaration types flow to server and client consumers;
- server dynamic request context and client static setContext-style context stay
  separate;
- archived flags return defaults with deprecation evidence;
- rapid flips coalesce to the latest value without repeated renders;
- evaluation outside a user request falls back to global/default context instead
  of throwing.

Run:

```text
npm.cmd --prefix src\draft\technical-proofs\sdk-flag-surface-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Sdk Flag Surface Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
