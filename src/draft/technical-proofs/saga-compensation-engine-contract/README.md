# Saga Compensation Engine Contract

Independent POC for HOBO-268. It fills the compensation body left as a seam by
`src/draft/technical-proofs/choreography-saga-engine-contract` without implementing deployment strategy templates,
drift-driven reconcile, or compensation-of-compensation escalation depth.

The contract proves:

- a partial deploy compensates only resources that reached `resource.Provisioned`;
- compensation runs in reverse topological order so dependents are destroyed before dependencies;
- `deployment.RolledBack`, `resource.Compensating`, and `resource.Compensated` replay into a
  no-provisioned-resources state with the rollback reason preserved;
- retries are idempotent and do not double-destroy resources already compensated in the log;
- optional resource failures continue without rolling back required provisioned resources;
- ambiguous provider state calls `refresh()` before `destroy()`;
- cyclic resource graphs fail closed instead of choosing an unsafe destroy order.

Run:

```sh
npm.cmd --prefix src/draft/technical-proofs/saga-compensation-engine-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Saga Compensation Engine Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
