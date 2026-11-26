---
type: CI Performance Finding
title: "Finding 129: cancelled release run still queued publish legs"
description: "Run 43162438966 was cancelled at 12:06 AM CST but six Publish GHCR images matrix legs stayed queued and held the main-train release concurrency group until run 43164708200 was force-cancelled at 12:27 AM CST."
tags: [hobo, ci, release, concurrency, cancel, ghcr]
---

# Finding 129: cancelled release run still queued publish legs

## Evidence

Release run [43162438966](https://github.com/Hobo-Labs/HoBo/actions/runs/43162438966) on commit `e0051f2e4` was **cancelled** at about 12:06 AM CST when a newer main-train release superseded it. **Build all OCI images on tag** legs were cancelled, but six **Publish GHCR images (tagged release)** jobs (`hobo-sdk`, `hobo-site`, `hobo-codegen`, `hobo-cli`, `hobo-mcp`, `hobo-ci-serve`) moved to **Queued** instead of being dropped. That run kept the `hobo-release-train-push-success` concurrency slot occupied, so the next release [43164708200](https://github.com/Hobo-Labs/HoBo/actions/runs/43164708200) waited about **30 minutes** until a force-cancel at 12:27 AM CST.

## Cause

Downstream release jobs used a job-level `if:` that started with `always()`. After a user cancel, GitHub still evaluates those expressions. **release-main-train-gate** and **release-images** had already succeeded, and **release-publish** did not require **release-oci-build-tag** to be green. `always()` stayed true, so the publish matrix still scheduled even though the OCI build matrix was cancelled — about **30 minutes** of queue time on the next train run.

Step-level `always()` on Turbo cache save inside **release-contract** is intentional: it does not schedule new jobs and does not hold the release concurrency group.

## Fix

- Replace `always()` with `!cancelled()` on **release-oci-build-tag**, **release-images**, **release-publish**, **release-attest**, **release-npm**, and **release-pages** job conditions, keeping the existing tag-train and needs-success guards.
- Require `needs.release-oci-build-tag.result == 'success'` before **release-publish** and **release-npm** so a cancelled build matrix cannot leave publish legs eligible.
- Pin the policy in `scripts/test/release-oci-attest-contract.test.ts`: publish-chain jobs must start with `!cancelled()` and must not mention `always()` at job scope.

## Verified

- `pnpm run test:smoke scripts/test/release-oci-attest-contract.test.ts`

## Not changed

- **release-pr-gate** keeps `always()` on GitHub-hosted `ubuntu-24.04` with no `uses:` steps — the pattern `scripts/lint-actions.ts` documents for attestation gates on PR paths.
- **release-tag** / **release-github** already used `!cancelled()`; no edit.
