---
type: CI Performance Finding
title: "Finding 107: a failed Pages deploy was never retried"
description: "The landing page merged in #1790 sat unpublished: its one deploy died on a blobless box git mirror, and the release gate only ever asked about the commit that triggered each run."
tags: [hobo, ci, release, pages, checkout, git, worker]
---

# Finding 107: a failed Pages deploy was never retried

## Symptom

[#1790](https://github.com/Hobo-Labs/HoBo/pull/1790) (the scroll-driven trail landing page) merged at
21:07 UTC on 2026-11-10 as `1948db4b`. Hours and seventeen commits later the live site still served the
landing page it replaced. `gh-pages` held one commit, `deploy: 93d367d9…`, pushed at 19:11 — before the
merge. `main` itself was intact: nothing after `1948db4b` touched the landing page, the trail, the cast or
the landmarks.

## Evidence

Release run [42903128893](https://github.com/Hobo-Labs/HoBo/actions/runs/42903128893) on `095489dd`
(the merge-queue batch that carried `1948db4b`) reached **Publish GitHub Pages** and failed in
`hobo-checkout`, three attempts, the same error each time:

```text
warning: filtering not recognized by server, ignoring
remote: fatal: could not fetch 00eb66aeea094b9b91d3c8973de0939c2af0c9fc from promisor remote
error: git upload-pack: git-pack-objects died with error.
fatal: protocol error: bad pack header
```

The OCI build jobs in that run failed in the same checkout step. The gate and contract jobs, which ran
GitHub-hosted, checked out the same commit without trouble.

No later run published either:

| Commit | Touches a release path | What happened |
| --- | --- | --- |
| `1948db4b` (#1790) | yes (`site/**`) | no CI run of its own: pushed in one merge-queue batch with `095489dd` |
| `095489dd` | yes | Pages job failed at checkout (above) |
| `bfa16d9c`, `d16b3380`, `e66f48d0` | yes | CI run cancelled |
| `db79b565`, `0abd3a5b` | yes | no CI run of their own (batched) |
| `930d37a3`, `e2cc77e1` | yes | CI run failed |
| `85323b2a` | yes | train gate job failed mid-step (its logs are gone); Pages skipped |
| the rest | no | gate said "not release-relevant" |

## Cause

Two faults, either of which alone would have been survivable.

**The gate had no memory.** `release-main-train-gate` ran
`check-release-relevant-push.mts --from "${head_sha}^" --to "${head_sha}"`: did *the commit that triggered
this run* touch a release path? A deploy that failed was never asked about again. Neither was a commit that
reached `main` behind another in one merge-queue push (only the last commit of a batch gets a CI run), nor
one whose CI run was cancelled by the next push. The site moved only when one commit both touched a release
path and got a green run and a working deploy, all at once.

**The box git mirror could not serve a checkout.** `createBoxGitMirror` cloned
`--bare --filter=blob:none` and then "backfilled" with `git fetch --no-filter origin HEAD`. That fetch is a
no-op: the blobless clone already has every commit, so the server has nothing to send and no blob arrives.
The job-side probe asked only whether the mirror had the *commit*, said hit, and pointed the checkout at it.
A `file://` remote ignores the checkout's own `blob:none` filter, so upload-pack reached for every blob of
the tree, found them missing, and tried to fetch them from GitHub through a read-only mount with no
credentials. All three attempts used the same mirror, so they were one failure three times.

This was reproduced with plain git, not read off the box: a mirror built by the old sequence has none of
the tree's blobs, and a depth-1 fetch through it fails with the four lines quoted above, word for word.
The box's own mirror was not inspected, and the 19:11 deploy on another fleet runner did succeed, so some
runners had either no mirror or a complete one.

Three smaller things made it worse:

- The Pages job needed the train gate, which installs dotnet and runs vitest. A runner lost there
  (`85323b2a`) skipped a deploy that had nothing to do with either.
- Nothing ordered two publishes. Release runs are keyed per commit, so two could push `gh-pages` in either
  order and the older commit could land last.
- The deploy commit named `github.sha`, which on a `workflow_run` event is the tip of `main` when the event
  fired, not the commit that was built.

## Fix

**Decide from what is published.**
[`scripts/ci/check-release-pages-stale.mts`](../../../scripts/ci/check-release-pages-stale.mts) reads the
commit `gh-pages` names and compares it with the commit under release:

| `gh-pages` relative to the commit | Decision |
| --- | --- |
| behind it, a release path changed since (or more than 300 files did) | deploy |
| behind it, no release path changed since | skip |
| the same commit | skip |
| ahead of it (an older run finishing late) | skip: never put an older site back |
| missing, unreadable, unknown to the repository, or on another line of history | deploy |

It runs in its own job, `release-pages-gate`, which needs only the `route` job, so the site no longer waits
on the train gate. `release-pages` holds a `hobo-release-pages` concurrency slot, asks the same question
again once it has the slot, and writes `deploy: <the commit it built>` so the next run reads the truth.
`workflow_dispatch` with `publish_pages` publishes `main` on request, without the release-path test and
under the same never-roll-back rule.

**Publish the same tree as the manual script.** The release job published `site/dist` alone, while
`scripts/deploy-site.mts` also nests the art catalogue under `/media/`, so a workflow deploy deleted
`/media/` from under a manual one. `release-pages` now builds `hobo-media` and nests it the same way.

**Make the mirror complete, and stop trusting it blindly.**

Most of this landed on `main` independently in #1857 while this finding was open: the worker now clones
full (no `--filter=blob:none`), repairs a partial or promisor mirror, the job-side probe refuses one, and
`hobo-checkout` disables the mirror after the first failed attempt. One gap remained, and this change closes
it:

- `createBoxGitMirror`'s repair stripped the partial-clone markers and fetched `main` without `--refetch`,
  which transfers nothing to a mirror that already has every commit. The mirror then claimed to be complete
  and reported a hit while still missing the blobs. The repair now fetches with `--refetch`, and before any
  hit the worker checks that the mirror holds every object of the commit's tree, refetching that commit
  whole if it does not. One that still cannot be completed is a miss.

## Verified

- `scripts/test/release-pages-stale.test.ts`: the decision table above, the GitHub API reader, and the
  workflow wiring.
- `packages/ci-gh-actions/test/git-mirror.test.ts`: a fresh mirror serves a depth-1 checkout with its
  origin unreachable; a blobless mirror is completed; one that cannot be completed is a miss. "A blobless
  mirror is completed" fails against #1857's `git-mirror.ts`, which reports a hit with the blobs missing.
- `scripts/test/box-git-mirror.test.ts`, `scripts/test/s0-checkout-cone.test.ts`: the probe misses a
  blobless mirror; the action leaves the mirror before attempt 2.

## Not changed

- The box worker has to be redeployed for the mirror fix to reach a box. Until then the probe and the
  checkout fallback carry it: an incomplete mirror is a miss, and the job fetches from GitHub as it did
  before the mirror existed.
- The release train (npm, GHCR, tag) still decides from the triggering commit alone. It has the same
  blind spot for batched and cancelled commits; "the next green run gets a higher height" covers a failed
  publish but not a commit that was never asked about.
- `scripts/deploy-site.mts` drives the built site in a real browser (`examples:verify-dist`) before it
  publishes. The release job does not; that check has never run on a fleet runner, and a gate that fails
  there would stop the site deploying, which is the fault this finding is about.
