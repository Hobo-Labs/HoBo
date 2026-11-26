# Feature Flag Governance Contract

Executable POC for HOBO-179. It proves the governance-side contract for
policy-gated feature-flag changes without implementing the Harness flag runtime.

The package consumes the existing built-in policy engine contract and emits
`policy.Decided` for flag-change decisions. It owns only the policy
classification, approval, obligation, and fail-closed governance boundary:

- prod kill-switch flips require approval;
- risky prod percentage rollouts require approval and carry a durable
  auto-revert obligation;
- low-risk dev flips are allowed without approvals or obligations;
- SLO burn signals can fire a durable auto-revert obligation into a
  `flag.RevertRequested` event;
- caller-supplied risk labels do not weaken prod kill-switch classification;
- direct prod gate bypass attempts are denied;
- prod flips fail closed when the evaluator is unavailable.

This proof treats a prod percentage rollout as risky when it increases to at
least 50 percent or by at least 25 percentage points.

Run:

```text
npm.cmd --prefix src\draft\technical-proofs\feature-flag-governance-contract test
```

## Boundary

No OpenFeature port, built-in flag store, in-process evaluator, reactive
re-evaluation, stale-flag cleanup, Harness transport, or SLO signal source is
implemented here. Those remain in the progressive-delivery Harness slices.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Feature Flag Governance Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
