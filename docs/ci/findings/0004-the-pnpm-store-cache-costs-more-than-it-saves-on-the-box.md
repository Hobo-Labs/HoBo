---
type: CI Performance Finding
title: "Finding 4: the pnpm store cache costs more than it saves on the box"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 4: the pnpm store cache costs more than it saves on the box

- On a PR, restoring the 1.26 GB store archive takes 31 s and the install after it 16 s.
- A cold registry install of the same lockfile (1997 packages) takes 21 s.
- On main the seed save takes 71–146 s and then fails to reserve the cache key.
- Before the restart the box's pnpm store resolved to `/home/runner/.local/share/pnpm/store/v10`: the
  daemon was not yet passing the shared host store from #1635 (`HOBO_CI_PNPM_STORE_MOUNTED`). GitHub's
  `env` context does not include the runner's process environment either, so the action's
  `env.HOBO_CI_PNPM_STORE_MOUNTED` test could never see it.

Fixes: [#1639](https://github.com/Hobo-Labs/HoBo/pull/1639) detects the mount in a shell step and skips the
GitHub cache on self-hosted runners (restore and save). Verified on the restarted box: "pnpm store is
host-mounted (/pnpm-store)", "reused 1997, downloaded 0", install 21–22 s with no archive restore.

A pre-baked store in the runner image was considered and not done. It saves at most ~15 s per install, goes
stale on every lockfile change, and adds the store to the image. The host-mounted store from #1635 gives the
same hard-link install once the box is redeployed.

Every `hobo-ci.yml` install now runs through `scripts/ci/pnpm-install.mts`. Each attempt has a **180 s**
deadline by default (`HOBO_PNPM_INSTALL_TIMEOUT_S` accepts only a positive integer), leaving ample headroom
over the measured 10–22 s warm installs. A timeout terminates the whole pnpm process group, with SIGKILL after
a 2 s SIGTERM grace; either a timeout or another non-zero exit triggers exactly one immediate retry with
`--prefer-offline`. Frozen-lockfile mismatches do not retry. Each attempt emits a JSON line containing its
number, arguments, outcome and duration so CI traces show the retry and its result.
