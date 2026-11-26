# Policy-gated flag flips contract

Executable proof for HOBO-345. It composes the existing flag event contract, policy IR, built-in
policy engine, and SLO burn event shape to prove that risky `flag.Changed` commits are policy-gated
before they enter the flag stream.

Run:

```sh
npm test -- src/draft/technical-proofs/policy-gated-flag-flips-contract/test/policy-gated-flag-flips.test.ts
```

The proof intentionally stays out of RBAC, policy-engine implementation, SLO signal production, and
shared rollout auto-revert mechanics.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Policy Gated Flag Flips Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
