# HOBO-6 CI Fabric Proof

This proof pins the M2 CI fabric contract from
[architecture.md](../../architecture.md), [walkthrough.md](../../walkthrough.md),
and [Plan 9](../../generated-stack.md#plan-09).

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| PR CI runs only checks relevant to the changed files and blocks on failure | `PR impact gate runs pnpm agent:check with the PR base instead of root-wide gates` |
| E2E authenticates to the sandbox cloud with no stored secret, deploys `hello-bindle`, asserts a live URL, tears down | `hello-bindle E2E uses keyless OIDC, asserts the live URL, and tears down` |
| E2E cost guard is label/schedule/manual gated and cleanup is asserted on failure | `cost guard keeps E2E behind a label, schedule, or manual dispatch` and `teardown and orphan sweep run even when the live URL assertion fails` |

## Adversarial Mapping

| Adversarial case | Guard |
|---|---|
| OIDC trust grants over-broad cloud access | `OIDC trust fails closed when the sandbox role is over-broad` |
| E2E leaks resources on failure | `missing teardown or orphan sweeper fails the E2E contract` |
| Flaky E2E blocks merges | `flaky E2E runs have a non-blocking quarantine lane` |

## Boundary

The executable proof lives in
[`src/draft/technical-proofs/ci-fabric-oidc-e2e-contract`](../../../../src/draft/technical-proofs/ci-fabric-oidc-e2e-contract/README.md)
(historical HOBO-6 evidence). **HOBO-586** promotes the contract to
[`packages/ci-guard`](../../../../packages/ci-guard/README.md)
as the production `@hobo/ci-guard` package. Reviewable workflows:
[`.github/workflows/hobo-ci.yml`](../../../../.github/workflows/hobo-ci.yml) and
[`.github/workflows/examples-e2e.yml`](../../../../.github/workflows/examples-e2e.yml).
The impact gate runs on `pull_request` for `main` (stack-aware base via
`origin/<base-ref>`). The **Main full gate** runs on `merge_group`, direct
`push` to `main`, the weekly schedule, and `workflow_dispatch`. Enable GitHub's
native merge queue on `main` in the **Hobo-Labs/HoBo** org so landing PRs use
`merge_group: checks_requested` with the same check names. PR runs use
`pnpm agent:check -- --base=origin/<base-ref>`; merge-queue candidates run the
full gate (`check:all`, architecture guard, full `turbo run test`). Event-aware
concurrency cancels stale PR runs but never cancels `merge_group` or `push` to
`main`. Runs that stay **`queued`** with no runner name indicate missing JIT
**`hobo`** registration—see [`packages/ci/RUNNER-QUEUE.md`](../../../../packages/ci/RUNNER-QUEUE.md).
The `pr-gate` job resolves `TURBO_SCM_BASE` via
[`scripts/ci/turbo-scm-base.mts`](../../../../scripts/ci/turbo-scm-base.mts):
`merge_group.base_sha` for merge queue events, `origin/<base-ref>` on PRs (stack
parent when using `gh stack`), otherwise `origin/main`. Gate jobs run on
self-hosted **`hobo`** JIT runners registered to **Hobo-Labs/HoBo** (runners
from the pre-transfer personal repo must be re-registered at org scope).
Turbo uses Vercel remote cache when `TURBO_TOKEN` / `TURBO_TEAM` are configured
(read-only on fork PRs), with `actions/cache` fallback on `.turbo/cache`.
Production package tasks derive `--filter=./packages/<name>`
and `--filter=./examples/<name>` from `git diff --name-only` so workspace-root
edits (for example `pnpm-workspace.yaml`) do not fan out into every package;
draft impact stays in `pnpm agent:check -- --base=...`.
Docs lanes run inside that same change-impact gate (the policy routes
`lint:docs` and `docs:freshness` on doc-affecting diffs), so there is no
standalone docs workflow to double-bill runner minutes.
Cost controls on the fabric itself: the label/schedule/manual fixture lanes
live in [`fixtures.yml`](../../../../.github/workflows/fixtures.yml)
(`pull_request: [labeled]` only), so adding a label re-runs just those lanes
instead of the whole PR gate, and `hobo-ci.yml` no longer retriggers on label
events at all; the weekly schedule skips `pr-gate` (it exists for `main-gate`
and the fixture sweeps); every job carries `timeout-minutes` instead of the
360-minute default; gate jobs use Turbo remote cache when configured, otherwise
`actions/cache` on `.turbo/cache` keyed by commit with an OS-scoped restore prefix.

This is a branch POC. It does not implement the runner/build-machine
cost-routed CI fabric, full multi-cloud E2E matrix, or real provider IAM
provisioning.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\ci-fabric-oidc-e2e-contract test
```
