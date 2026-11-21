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
deploy and App-deposit jobs must use `ubuntu-24.04` and `clean: true`. `scripts/lint-actions.ts` exempts
this workflow from fleet routing and scopes its per-job hosted-runner exception
to those jobs and the unprivileged `deploy-build` job. Building and deploying
are separated so the GitHub OIDC identity reaches no build code:
`deploy-build` holds `contents: read` only and packs the built hobo CLI with
its sha256 (`scripts/ci/release-freight-cli.mts pack`); each job that holds
`id-token: write` (`deploy`, `app-credentials`) restores it only when the
digest matches the build job's output and the archive's manifest names the
commit it checked out (`release-freight-cli.mts restore`, fail closed
otherwise), before any step that runs the CLI. The delivery and App-deposit summary lines pass the CLI's
envelope message through a bearer/JWT/credential redaction before the job
summary sees it, and the report script exits nonzero unless the command's
envelope is a validated success envelope (`ok: true`) with a valid exit
status — an absent, malformed, or error envelope is a failure even when the
recorded status is 0 (the workflow test runs the delivery step's script
against a fake `hobo.js` that answers with a credential-shaped message and
asserts the summary shows `[redacted]`), and the CLI masks the store-read
`VERCEL_TOKEN` with `::add-mask::` on any run the OIDC mint env marks as a
CI runner (`packages/hobo/test/ci-relay-deploy.test.ts`). The gate treats an
absent or unreadable `packages/ci-vercel/deploy/secret-store.binding.json`
as a required-check failure; the committed binding carries coordinates only.
The store-read-credential → CD-deploy channel is built, not proven: the
first production run after merge — relay-deploy.yml on the first
relay-relevant push to `main` — must show the *Verify the secret store
connection* check passing and the *Deliver the relay through HoBo CD* step
summary carrying both targets, and be linked per the cutover plan
(`packages/ci-vercel/README.md`, "Merge cutover").
