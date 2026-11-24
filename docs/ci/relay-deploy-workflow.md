---
type: Reference
title: "Relay deploy workflow gates"
description: "Executable checks on .github/workflows/relay-deploy.yml."
tags: [hobo, ci, relay, workflow]
---

# Relay deploy workflow gates

[`scripts/test/relay-deploy-workflow.test.ts`](../../scripts/test/relay-deploy-workflow.test.ts)
pins the relay deploy workflow: the *Verify the secret store connection* step
must invoke `hobo ci secret-store verify` in its own body and must appear
before *Deliver the relay through HoBo CD* by step line order, not by
whole-file substring search. Every job's checkout (`deploy-build` included)
pins submodules and persists no credentials. The gate never quietly skips a
manual run — on `workflow_dispatch` it either deploys or fails the job — so
`app-credentials`, which needs `deploy-build` and downloads its artifact
unconditionally, can never hit a missing artifact. The credential-bearing
deploy and App-deposit jobs must use `ubuntu-24.04` and `clean: false` with
`persist-credentials: false` and an explicit `fetch-depth`. The unprivileged
`deploy-build` job uses `clean: true`. `scripts/lint-actions.ts` exempts
this workflow from fleet routing and scopes its per-job hosted-runner exception
to those jobs and the unprivileged `deploy-build` job. That exception is earned, not name-based: every hosted
job must pin the reviewed checkout, set the reviewed clean/fetch policy, keep no credentials or
route-runner step, hold only its declared permissions, and restore the CLI from
the build job's digest before running repository code. That order is enforced
on parsed steps, comments aside — checkout, then the pinned artifact download,
then the digest restore carrying exactly the build job's `digest` output as its
one env entry, then any step that runs the CLI. This workflow carries no
route-runner step; `scripts/test/route-runner.test.ts` names the exact workflows
that still route, so one joining or leaving them (relay-deploy.yml is
deliberately unrouted) is a reviewed change, not a silent drift past a floor. Building and deploying
are separated so the GitHub OIDC identity reaches no build code:
`deploy-build` holds `contents: read` only and packs the built hobo CLI with
its sha256 (`scripts/ci/release-freight-cli.mts pack`); each job that holds
`id-token: write` (`deploy`, `app-credentials`) restores it only when the
digest matches the build job's output and the archive's manifest names the
commit it checked out (`release-freight-cli.mts restore`, fail closed
otherwise), before any step that runs the CLI. The delivery and App-deposit
report scripts load the provider redactor from that restored bundle's `dist`.
Their summary lines pass both the CLI's envelope code and message through a
bearer/JWT/credential redaction, including percent-encoded bearer tokens, before the job summary sees it, and the result
report script exits nonzero unless the command's
envelope is a validated success envelope (`ok: true`) with a valid exit
status — an absent, malformed, or error envelope is a failure even when the
recorded status is 0. A success envelope may omit `code` (`hobo ci app
deposit` succeeds with a message only); the report names that case `HOBO_OK`
(the workflow test runs the delivery step's script
against a fake `hobo.js` that answers with a credential-shaped message and
asserts the summary shows `[redacted]`), and the CLI masks the store-read
`VERCEL_TOKEN` with `::add-mask::` only when `GITHUB_ACTIONS=true`, never merely
because OIDC mint variables are present
(`packages/hobo/test/ci-relay-deploy.test.ts`). The store's coordinates live only in the owner's store (the
`HOBO_CI_SECRET_STORE_BINDING` entry), never in the repository, so a push
deploys nothing: the gate posts a notice to deploy through `hobo cd` after
HoBo MCP's `choose_secret_store`, and the protected job's `hobo` commands stop
with `HOBO_CI_SECRET_STORE_SESSION_REQUIRED` unless an owner store session is
established for them. The store-read-credential → CD-deploy channel is built,
not proven: the first production delivery through that session must show the
*Verify the secret store connection* check passing and both targets delivered,
and be linked (`packages/ci-vercel/README.md`). The delivery step runs both
targets as `hobo ci deploy --cwd packages/ci-vercel --sha "$GITHUB_SHA" --target
"$target" --wait` in the `id-token: write` job; preview `--wait` is refused
without `--sha` and GitHub OIDC, and production creation never assigns custom
domains before HoBo promotes it.

## Gate contract

`scripts/ci/relay-deploy-gate.mts` answers two questions from a closed input
set: does this event deploy, and by when. A pull request never deploys. A push
never deploys: when a changed path is a relay input, or the push range cannot be
read, the gate posts the notice to deploy through `hobo cd` with the owner's
store session. A manual run deploys, and its protected job's `hobo` commands
need an established owner store session. The gate writes `run`, `reason`, and
the ISO `deadline` to GitHub's output, prints the skip or deploy notice, and on
failure prints `::error title=Relay deploy failed::` with exit 1. The deadline
is the job timeout less its setup and summary margin, and bounds the whole
delivery step, not only adoption. The workflow test pins this decision table
and output contract; no repository variable or secret is read.
