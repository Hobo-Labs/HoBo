---
type: CI Performance Finding
title: "Finding 164: the App credentials workflow failed before any job started"
description: "app-credentials.yml calls relay-deploy.yml, whose route job reads actions, but the calling job granted only contents and id-token. GitHub refused the call before any job started, so every push to every branch recorded a failed run and a dispatch could not deposit the GitHub App's credentials. The calling job now grants actions: read and sets only keys a reusable-workflow caller accepts (no timeout-minutes)."
tags: [hobo, ci, github-app, workflows, permissions]
---

# Finding 164: the App credentials workflow failed before any job started

## Measurements

Run 45314457251 (push to `claude/kind-ritchie-pcw0jk-owner-entries`) ended `failure` with no jobs and the workflow's path as its name. The same happened on every recent push: `claude/kind-ritchie-pcw0jk-parity`, `claude/kind-ritchie-pcw0jk-owner-store-only`, `claude/dazzling-bardeen-1zrzg9`, `claude/funny-mayer-jiczdp-mq-delta` and the merge queue branch `gh-readonly-queue/main/pr-2979-…`.

`app-credentials.yml` has only a `workflow_dispatch` trigger, so a push should start nothing. GitHub still validates the reusable workflow it calls: `relay-deploy.yml`'s `route` job asks for `actions: read`, and the calling job `app-credentials` granted `contents: read` and `id-token: write` only. A called job cannot ask for more than its caller grants, so GitHub rejected the workflow file before any job.

Granting `actions: read` was not enough: run 45340482933 (push of `162eea75f8`) still failed with no jobs. The calling job also set `timeout-minutes: 20`, and a job that `uses:` a reusable workflow accepts only `name`, `uses`, `with`, `secrets`, `needs`, `if`, `permissions`, `strategy` and `concurrency`. The same failure showed on every merge-queue branch (`gh-readonly-queue/main/pr-2953-…`, `pr-1979-…`, `pr-2709-…`).

## Fixes

- `.github/workflows/app-credentials.yml`: the `app-credentials` job grants `actions: read` beside `contents: read` and `id-token: write`, and drops `timeout-minutes` (relay-deploy's own jobs carry their timeouts).
- `packages/ci-vercel/CONFIG-SERVICE.md` says why the caller grants it.

## Evidence

- `scripts/test/relay-deploy-workflow.test.ts`, including the repository's workflow lint; it now fails when the calling job sets a key a reusable-workflow caller does not accept.
- `scripts/test/workflow-job-timeouts.test.ts` required `timeout-minutes` on every job, which is what put it on the caller job. It now requires it only on jobs that run steps, and requires its absence on a job that `uses:` a reusable workflow.
