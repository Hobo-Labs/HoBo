# HOBO-208 GitOps CI Journey Proof

HOBO-208 is proven by the focused POC at
[`src/draft/exp-proofs/dx/gitops-ci-journey-contract`](../../../../src/draft/exp-proofs/dx/gitops-ci-journey-contract/README.md).

## Acceptance Evidence

| Acceptance | Executable proof |
|---|---|
| PR `hobo plan --camp staging` posts a diff and has no side effects | `posts a read-only PR plan, ships staging, manages preview, and promotes a known-good revision keylessly` asserts the posted `hobo.plan` comment, `would-change` diff, and empty side-effect event list. |
| Merge to main ships staging | Same test asserts `hobo up --camp staging` returns `deployed`, selects the head revision, and ends with `deployment.UpCompleted`. |
| Per-PR preview stands up and tears down | Same test asserts `hobo up --camp pr-42` opens `camp:acme:snapshop:pr-42` with a preview URL, then `hobo down --camp pr-42` returns `destroyed`; it also asserts abandoned preview TTL expiry requests teardown. |
| Production promotion is a pointer to a known-good revision | Same test asserts `hobo up --camp prod --to <sha>` deploys the exact head SHA with an explicit revision selector. |
| Keyless OIDC has no persisted cloud secret | Same test asserts `token.Granted` and `token.Used` with `persistedSecretCount` equal to `0`. |
| `can-deploy` skew blocks `up` with a machine-readable reason | `blocks a can-deploy skew before any prod apply with a machine-readable deploy-order fix` asserts `can-deploy.skew`, dual-publish/deploy-order fix text, and no mutation events. |
| Rollback re-realizes last-good | `re-realizes the last-good production revision on rollback` asserts `hobo up --camp prod --rollback` selects the last-good revision from the event log. |

## Adversarial Evidence

| Adversarial case | Guard |
|---|---|
| Prod consumers cannot take a change | The can-deploy skew test blocks before apply and returns the dual-publish/deploy-order fix. |
| Abandoned PR preview tears down | The happy-path test asserts preview TTL expiry returns `deprovision` and emits `deploy.PreviewTeardownRequested`. |
| Forged or expired OIDC is rejected | `rejects forged or expired OIDC before any GitOps command mutates state` rejects the token and leaves command/mutation lists empty. |
| Wrong revision promotion | `catches a wrong production revision at the promotion gate` rejects `revision.not-known-good` before apply. |
| Drift surfaces an event | `surfaces drift as an event and reconcile PR instead of silent apply` emits `resource.DriftDetected`, creates reconcile PR metadata, and marks `silentApply` false. |

## Scope Boundary

This branch intentionally consumes the existing plan preview, up convergence, down lifecycle,
preview environment, and OIDC federation contracts. It does not implement progressive delivery,
canary flags, OIDC broker internals, or CI provider runner fabric.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\gitops-ci-journey-contract test
```
