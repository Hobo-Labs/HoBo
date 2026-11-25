# Training Data Poisoning Guard Contract

Independent HOBO-358 POC for the training/data flywheel poisoning boundary.

The contract models the guard that runs before an optimizer-produced candidate
can be promoted from trajectory and label evidence:

- poisoned trajectory labels are quarantined before scoring;
- label-flip, reward-inflation, gradual-drift, and Sybil-burst fixtures are
  executable adversarial vectors;
- promotion requires a passing contract backstop, enough independent trusted
  sources, enough shadow evidence, and trusted reward above the floor;
- candidate influence replay reconstructs trusted trajectory ids, quarantined
  trajectory ids, and trusted hashes from append-only events.

Scope kept out: optimizer implementation, model training, live traffic routing,
provider calls, and champion swap application.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\training-data-poisoning-guard-contract test
```

Design proof: [HOBO-358 training data poisoning guard](../../../../docs/design/proofs/hobo-358-training-data-poisoning/README.md).


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Training Data Poisoning Guard Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
