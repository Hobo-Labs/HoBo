# CI performance notes

How the self-hosted HoBo CI keeps PR gates fast, and where to look when it slows down.

- **Parallel isolated containers.** The box worker (`packages/ci-gh-actions/scripts/isolated-worker-daemon.mts`)
  runs up to `HOBO_CI_WORKER_SLOTS` jobs at once, each capped by `HOBO_CI_WORKER_MEMORY_MB`. Raise the
  relay offer concurrency to match the slot count.
- **Shared pnpm store.** `.github/actions/pnpm-store` mounts one content-addressed store across jobs so
  installs hard-link instead of downloading.
- **Full clones.** Checkouts stay full (no `filter: blob:none`): a blobless clone fetches every blob
  lazily at checkout and timed out with HTTP 408 on this repo.
- **Slimmer impact gate.** `scripts/ci/affected-lanes.mts` maps changed paths to lanes so the PR gate
  only runs the lanes a change can affect; `scripts/test/affected-lanes.test.ts` pins the skip logic.
- **Trace export.** `.github/actions/ci-trace` runs `scripts/ci/ci-trace.mts` to export per-step timings
  from each job, so queue time and run time can be compared before and after a change.
