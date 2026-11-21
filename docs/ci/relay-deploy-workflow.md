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
whole-file substring search. The credential-bearing deploy and App-deposit jobs
must use `ubuntu-24.04` and `clean: true`. `scripts/lint-actions.ts` exempts
this workflow from fleet routing and scopes its per-job hosted-runner exception
to those two jobs. The delivery and App-deposit summary lines pass the CLI's
envelope message through a bearer/JWT/credential redaction before the job
summary sees it (the workflow test runs the delivery step's script against a
fake `hobo.js` that answers with a credential-shaped message and asserts the
summary shows `[redacted]`), and the CLI masks the store-read `VERCEL_TOKEN`
with `::add-mask::` on Actions runs
(`packages/hobo/test/ci-relay-deploy.test.ts`). The gate treats an absent or
unreadable `packages/ci-vercel/deploy/secret-store.binding.json` as a
required-check failure; the committed binding carries coordinates only. The
first production run after merge must show the store-verify to deliver channel
carrying a value (`packages/ci-vercel/README.md`, "Merge cutover").
