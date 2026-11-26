# Launch Blocker Taxonomy Contract

HOBO-402 defines the v1 launch-blocker severity taxonomy and go/no-go exception posture.

This POC records a machine-checkable contract in `src/launch-blocker-taxonomy.mjs`:

- `severityTaxonomy` defines launch blocker, high-risk non-blocker, launch note, and post-GA follow-up.
- `exceptionProcess` requires evidence, expiry, and an approved role before a non-blocking exception can ship.
- `sourceRouting` maps dogfood, beta, support, security, legal/privacy, and upgrade findings into go/no-go inputs.
- `exampleTriageCases` gives concrete triage examples for each source and decision class.
- `scopeGuards` proves this issue does not resolve blockers, implement runtime policy, or override CI, review, security, or contract-test gates.

Run:

```sh
npm.cmd --prefix src\draft\exp-proofs\cx\launch-blocker-taxonomy-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Launch Blocker Taxonomy Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
