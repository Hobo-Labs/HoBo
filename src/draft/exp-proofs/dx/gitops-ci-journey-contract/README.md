# GitOps CI Journey Contract POC

HOBO-208 proof for the PR-driven GitOps path:
PR plan -> staging deploy -> preview Camp up/down -> production promotion by revision -> rollback.

## What This Proves

- A PR can run `hobo plan --camp staging`, produce a reviewable plan comment, and emit no side
  effects.
- A merge to main can run `hobo up --camp staging` and record a completed deployment at the head
  revision.
- A PR preview can be opened as `hobo up --camp pr-N`, receive an isolated preview URL, and be torn
  down through `hobo down --camp pr-N`.
- An abandoned PR preview expires through the preview TTL reaper and requests teardown.
- Production promotion uses `hobo up --camp prod --to <sha>` and only accepts a known-good revision.
- CI identity is keyless OIDC: token evidence is `token.Granted` and `token.Used`, with zero static
  credential reads or persisted secrets.
- `hobo up --camp prod --rollback` selects the last-good revision from the deployment event log.

## Adversarial Coverage

- `can-deploy` skew blocks production promotion before provision/apply/deploy mutation events and
  returns a machine-readable `can-deploy.skew` reason plus dual-publish/deploy-order fix.
- Abandoned PR preview TTL expiry returns a `deploy.PreviewTeardownRequested` event.
- Expired or forged OIDC credentials are rejected before any GitOps command runs.
- Unknown production revisions are caught by the promotion gate before any apply.
- Drift emits `resource.DriftDetected` and opens a reconcile PR instead of silently applying live
  state.

## Boundary

This package composes existing POC contracts for plan preview, `hobo up`, `hobo down`, preview
environments, and OIDC federation. It does not implement progressive-delivery harness flags/canary,
OIDC broker internals, or CI provider runner fabric.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\gitops-ci-journey-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Gitops Ci Journey Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
