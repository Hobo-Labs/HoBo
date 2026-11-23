---
type: CI Performance Finding
title: "Finding 160: ARC pods installed from a cold store every job"
description: "On pull request 2953 every hobo-trunk failure traced to our runner code: ARC pods had no shared pnpm store, the live data lane's MongoDB hit a 1024 open-file limit, and the PR secret scan read a reused blob:none workspace. The fixes add node caches for ARC pods, a stall-based install bound, a fixture open-file limit and a range blob prefetch."
tags: [hobo, ci, performance, arc, pnpm, data-live, secret-scan, caches]
---

# Finding 160: ARC pods installed from a cold store every job

## Measurements

Run 45206283883 (pull request 2953) put eight jobs on `hobo-trunk`. Six failed or were cancelled. The same jobs passed on `ubuntu-24.04` in the 12 runs before it.

| Job | Runner | Result | Same job on `ubuntu-24.04` |
| --- | --- | --- | --- |
| hobo dev cold loop | ARC `hobo-trunk-runner-qsgr8` | install timed out twice, 594 s | 39–52 s |
| PR off-path checks | ARC `hobo-trunk-runner-qzhhc` | cancelled at its 10-minute limit | 79–282 s |
| artifact signing and install verification | ARC `hobo-trunk-runner-2hgqs` | cancelled at its 10-minute limit | 24–66 s |
| Workspace test shards 3 and 5 | ARC `hobo-trunk-runner-*` | install timed out twice | — |
| Live data engines | Agent37 `a37-gja3yx8xiu-1795381664` | suite step timed out at 8 minutes | 144–255 s |
| Secret scan | Agent37 `a37-8n8iu87d2j-1795381563` | failed after 9 s, scanned 0 bytes | 22–31 s |

### ARC pods: a cold pnpm store in every pod

Each failing ARC job ran `scripts/ci/pnpm-install.mts` against an empty store. `.github/actions/pnpm-store` logged `self-hosted runner without a mounted store; installing from the registry`.

- Cold loop (filtered install): `resolved 818, reused 0` at the start of attempt 1. After 182 s pnpm had downloaded about 410 packages. Attempt 2 reused the 406 that attempt 1 had stored and timed out after another 182 s.
- Off-path checks and artifact signing (full install): 2198 packages, `reused 493` and `reused 574` after two 181 s attempts.
- Workspace test shard 3: `reused 666, downloaded ~1121`, two 181 s timeouts.
- pnpm warned `Tarball download average speed 2 KiB/s (size 7 KiB)` and up to 17 KiB/s per tarball.
- On the same pod, `actions/cache` restored at 4.2 MB/s (shard 3), against 16–22 MB/s on GitHub-hosted. The 1.3 GB store archive would take about 5 minutes there, so it is no substitute for a local store.

The two cancelled jobs hit their 10-minute limits. That time went to the install's two 181 s attempts, plus about 110 s spent downloading the self-repository action archive (`Download action repository 'Hobo-Labs/HoBo@4da35cf'`, which took 2.6 s on Agent37), plus about 70 s of checkout. GitHub reports a `timeout-minutes` stop as `cancelled`.

The `Failed to create bin ... ENOENT` warnings on shard 5 are not a cause. A passing GitHub-hosted run of the live data lane prints the same warning 40 times. Workspace bins point at `dist/` files that the build step writes later.

### Agent37: MongoDB ran out of file descriptors

The live data lane started its servers in 70 s (16 s on GitHub-hosted). The suites then ran 10–40 times slower than on GitHub-hosted (`@hobo/data-sqlite` took 173 s against 4 s). During `@hobo/data-postgres`, mongod aborted:

```
WiredTiger error ... "__posix_directory_sync:256:/data/db/: directory-sync: open","error_str":"Too many open files","error_code":24
Fatal assertion ... aborting after fassert() failure
```

Agent37's Docker engine gives containers a 1024 `nofile` limit. GitHub's engine allows far more. With mongod dead, the MongoDB suite waited until the step's 8-minute limit.

### Agent37: the secret scan read a reused partial clone

The Secret scan job checked out into `/root/runner-work/s1/HoBo/HoBo`. That workspace was left behind by an earlier `hobo-checkout` job (`filter: blob:none`), so its `.git` kept `remote.origin.partialclonefilter=blob:none`. `actions/checkout` with `fetch-depth: 0` ran `git fetch --unshallow` without `--filter`, and git applied the configured filter anyway: it fetched history but not blobs. Betterleaks does not fetch missing objects lazily. It logged `fatal: unable to read 2912d190…`, `scanned ~0 bytes` and failed. A local reproduction with betterleaks 1.10.1 gives the same error on a `blob:none` clone and a clean scan once the range's blobs are present.

## Fixes

- **Node caches for ARC pods.** `scripts/ci/arc-runner-caches.mts` patches the `AutoscalingRunnerSet` idempotently. It mounts the node's `/var/lib/hobo-ci/pnpm-store` and `/var/lib/hobo-ci/images` (hostPath, owned by UID 1000) and sets `HOBO_CI_PNPM_STORE_DIR` and `HOBO_CI_IMAGE_CACHE_DIR`. `--prewarm` runs `pnpm fetch --frozen-lockfile` for the whole workspace lockfile into the node store, so filtered and full installs both start warm. See [the deploy README](../../../packages/ci-gh-actions/deploy/README.md#arc-runner-node-caches).
- **Installs use that store.** `scripts/ci/pnpm-install.mts` sets `npm_config_store_dir` from `HOBO_CI_PNPM_STORE_DIR` when the directory is writable. The pnpm-store action skips `actions/cache` there and warns `hobo-ci-cold-pnpm-store` when a self-hosted runner has no shared store. The Turbo local cache moves into the same store, as on the box.
- **A stall bound instead of a wall-clock bound.** `pnpm-install.mts` restarts its 180 s deadline whenever pnpm's `Progress: resolved, reused, downloaded, added` counters change. An install that is still downloading is no longer killed and restarted. One that stops making progress is killed and retried once with `--prefer-offline` against everything it already stored.
- **Images from the node cache.** `data-live-servers.mts up` loads the digest-pinned PostgreSQL and MongoDB images from `HOBO_CI_IMAGE_CACHE_DIR/<digest>.tar` when the engine lacks them. After the first pull it saves them there, so a pod's fresh Docker engine does not pull roughly 1 GB per run.
- **Fixture open-file limit.** Both fixture servers start with `--ulimit nofile=65536:65536`, and the compose file sets the same limit.
- **PR secret scan prefetches its range.** The Secret scan job runs `betterleaks-main-scan.mts --range <base>..<head>`. It fetches both sides of every change in the range (the main gate's `prefetchRangeBlobs`) before betterleaks runs, and fails closed if a blob cannot be fetched. A workspace that inherited `blob:none` therefore scans the full range instead of 0 bytes.

## Still to do on the hosts

- Run `scripts/ci/arc-runner-caches.mts --scale-set hobo-trunk --namespace <ns> --apply --prewarm Hobo-Labs/HoBo <main sha>` against the Hostinger cluster, and the same for the `hobo-runner` scale set. Run it again after any `helm upgrade` of a scale set. Until then, ARC jobs warn `hobo-ci-cold-pnpm-store`.
- Agent37 hosts need nothing new for the fixes above. Their 10–40× slower test runs come from CPU and disk, and no cache fixes that.
- The self-repository action archive (`$/` actions, about 110 s per ARC job) is downloaded per commit. It stays until the actions-lock form changes.

## After

Re-measure the same five jobs on `hobo-trunk` once the scale set is patched and prewarmed. The table above is the baseline.
