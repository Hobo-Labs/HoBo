---
type: CI Performance Finding
title: "Finding 164: the App credentials workflow failed before any job started"
description: "app-credentials.yml calls relay-deploy.yml, whose route job reads actions, but the calling job granted only contents and id-token. GitHub refused the call before any job started, so every push to every branch recorded a failed run and a dispatch could not deposit the GitHub App's credentials. The calling job now grants actions: read."
tags: [hobo, ci, github-app, workflows, permissions]
---

# Finding 164: the App credentials workflow failed before any job started

## Measurements

Run 45314457251 (push to `claude/kind-ritchie-pcw0jk-owner-entries`) ended `failure` with no jobs and the workflow's path as its name. The same happened on every recent push: `claude/kind-ritchie-pcw0jk-parity`, `claude/kind-ritchie-pcw0jk-owner-store-only`, `claude/dazzling-bardeen-1zrzg9`, `claude/funny-mayer-jiczdp-mq-delta` and the merge queue branch `gh-readonly-queue/main/pr-2979-…`.

`app-credentials.yml` has only a `workflow_dispatch` trigger, so a push should start nothing. GitHub still validates the reusable workflow it calls: `relay-deploy.yml`'s `route` job asks for `actions: read`, and the calling job `app-credentials` granted `contents: read` and `id-token: write` only. A called job cannot ask for more than its caller grants, so GitHub rejected the workflow file before any job.

## Fixes

- `.github/workflows/app-credentials.yml`: the `app-credentials` job grants `actions: read` beside `contents: read` and `id-token: write`.
- `packages/ci-vercel/CONFIG-SERVICE.md` says why the caller grants it.

## Evidence

- `scripts/test/relay-deploy-workflow.test.ts`, including the repository's workflow lint.
