# HoBo Up Convergence Contract

Independent POC for HOBO-130. It pins the `hobo up [--camp --strategy --to --rollback]`
command seam over a replayable event log without implementing Planner, Gatekeeper, Delta apply,
provider IaC, rollback compensation, or anonymous deploy internals.

The contract proves:

- `hobo up` drives collect -> plan -> gate -> apply -> deploy through explicit seams.
- A local/dev Camp provisions and deploys a sample app and returns a JSON result with revision and
  live URL.
- Re-running `up` against the same manifest/revision is an idempotent no-op and does not call apply
  or deploy again.
- `--to <rev>` re-realizes a named revision, while `--rollback` selects the last-good revision from
  the event log.
- Gate denial is a clean no-op: it emits a machine-readable block reason and calls neither apply nor
  deploy.
- `--to` plus `--rollback` is rejected before collection.
- An interrupted deploy resumes from the applied Set and does not provision the same resources
  again.
- Production compatibility refusal carries the dual-publish/deploy-order fix instead of applying.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-up-convergence-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Up Convergence Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
