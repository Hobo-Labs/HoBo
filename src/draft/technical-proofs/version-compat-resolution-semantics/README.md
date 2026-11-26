# Version/Compat Resolution Semantics

Independent HOBO-340 spike proof. This folder records executable test vectors for the future distributed-artifact resolver (HOBO-370). It is not the production resolver and does not implement registry IO, yank handling, upcaster execution, or CLI behavior.

The vectors encode ADR-0095:

- initial install chooses the highest compatible candidate from a canonical catalog snapshot,
- ordinary plan preserves an existing manifest pin when it still satisfies the request,
- explicit upgrade mode may move the pin, but a preview/experimental bump requires a declared upcaster,
- dependency constraints are intersected deterministically, with incompatible diamonds reported as conflicts,
- manifest pins are authoritative over lockfile hints, and lock mismatches fail closed,
- deprecated candidates lose to non-deprecated candidates and expire out of redeploy selection,
- catalog ordering cannot affect the resolved digest set.

Run:

```sh
npm test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Version Compat Resolution Semantics.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
