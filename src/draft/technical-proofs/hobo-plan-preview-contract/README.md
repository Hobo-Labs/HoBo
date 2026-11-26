# HoBo Plan Preview Contract POC

Independent POC for HOBO-125. It pins the `hobo plan [--camp]`
read-only preview boundary after collection, Matching, and Planner have produced
their branch-local facts.

The package covers:

- human output that names each resource, resolved provider, reason, and estimated
  monthly cost;
- stable `--json` CI envelope with command, camp, status, plan hash, cost
  assumptions, warnings, changes, and side-effect evidence;
- no-op re-plan semantics when the current `DeploymentSet` already carries the
  same plan hash;
- fail-closed required-capability errors that name the offending port;
- warning surfaces for ambiguous provider resolution, non-portable `raw()`
  escapes, cost-estimate assumptions, and cross-cloud connectivity tiers;
- unknown Camp errors before planning;
- explicit proof that `plan` emits no provisioning side-effect events.

This POC consumes the existing DeploymentPlan IR validator/content hash and uses
fake collector/matcher/planner seams. It does not implement the production CLI,
real Matching, real Planner, provider registry storage, CI comment posting, or
`hobo up` provisioning.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-plan-preview-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Plan Preview Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
