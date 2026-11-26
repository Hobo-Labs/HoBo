# HOBO-130 Up Convergence Proof

HOBO-130 is proven by the focused POC at
[`src/draft/technical-proofs/hobo-up-convergence-contract`](../../../../src/draft/technical-proofs/hobo-up-convergence-contract/README.md).

## Acceptance Evidence

- Local/dev happy-path test proves collect -> plan -> gate -> apply -> deploy and returns a JSON
  result with revision and live URL.
- Idempotency test proves a second `hobo up` against the same manifest and revision emits
  `deployment.UpNoop` and calls neither apply nor deploy.
- Revision-selector tests prove `--to <rev>` re-realizes an explicit revision and `--rollback`
  selects the last-good revision from the event log.
- Gate-denial tests prove a blocked gate emits `deployment.PlanRejected` with actionable fix text
  and zero `resource.Provisioned` / `deployment.SetApplied` facts.
- Resume test proves an interrupted deploy resumes from the already-applied Set and does not
  provision resources again.
- Negative tests cover `--to` plus `--rollback` and the prod compatibility block that points at the
  dual-publish/deploy-order fix.

## Scope Boundary

This branch intentionally consumes Planner, Gatekeeper, Delta apply, provider IaC, and deploy
runtime as explicit seams. It does not implement those engines, anonymous `npx hobo up`, `hobo down`,
real rollback compensation, or policy/gate internals.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-up-convergence-contract test
```
