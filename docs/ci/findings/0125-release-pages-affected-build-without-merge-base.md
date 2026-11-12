---
type: CI Performance Finding
title: "Finding 125: release pages affected build without merge base"
description: "The Pages job built only what changed since origin/main; on a shallow checkout of a commit main had already moved past, turbo found no merge base and the release could not tag."
tags: [hobo, ci, release, pages, turbo, shallow-checkout]
---

# Finding 125: release pages affected build without merge base

## Evidence

Release run [43153007352](https://github.com/Hobo-Labs/HoBo/actions/runs/43153007352) released `9769dae8`. Its **Publish GitHub Pages (site/)** job (`130966493089`) failed in **Build hobo-site workspace deps for prebuild** after 58 seconds:

```text
x Unable to query SCM: Git error: fatal: no merge base found
```

`release-tag` needs Pages to succeed, be skipped or be cancelled, so a failed Pages build blocks the signed tag and the GitHub Release.

## Cause

`build-release-site-prebuild.mts` ran `turbo run build --filter=hobo-site...[origin/main...HEAD]` whenever `HOBO_RELEASE_TURBO_BASE` (the workflow default, `origin/main`) differed from the commit under release. The checkout is shallow (`fetch-depth: 1`) and `origin/main` is fetched shallow too, so once `main` has moved past the green commit the two share no history and Turbo cannot find a merge base.

That is now the usual case. Main pushes queue instead of cancelling ([finding 113](0113-main-ci-starved-by-cancel-in-progress.md)), so by the time a release runs, `main` is usually ahead of the commit it releases. The previous release succeeded only because `main` had not moved.

The filter was wrong even with full history. The commit under release is an ancestor of `origin/main`, so "changed since the merge base" selects nothing, and the job runs on a fresh runner, where an unbuilt package has no `dist`.

## Fix

- The prebuild always builds the whole `hobo-site...` closure. The Turbo cache already skips packages that did not change.
- `release-pages` sets `HOBO_RELEASE_TURBO_BASE: ""`, like the OCI build and publish jobs.

## Verified

`scripts/test/build-release-site-prebuild.test.ts` pins the full-closure arguments, that the script never builds a `...HEAD]` range, and the empty base on `release-pages`.
