---
type: CI Performance Finding
title: "Finding 19: every job installed both CPUs' agent CLIs"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 19: every job installed both CPUs' agent CLIs

`pnpm install --frozen-lockfile` takes 19–26 s per job on the box, and 44–46 s when both slots install at
once. Nothing is downloaded ("reused 1997, downloaded 0"); the time goes to writing `node_modules`.

- The store is the host mount `/pnpm-store` and the workspace is on the container's overlay, two
  filesystems, so pnpm cannot hard-link and copies every file.
- Root `package.json` set `pnpm.supportedArchitectures.cpu` to `["arm64", "x64", "current"]`, added with
  the docs-portal contract in #510 without a stated reason. `@agentv/core` (used by `provider-agentv` and
  ts-autocode's `training`) depends on `@openai/codex` and `@github/copilot`, whose native packages are
  190–280 MB per platform. Every job copied both CPUs' builds, about 1.1 GB, and could run one of them.

The setting is now `["current"]`. The lockfile does not change: it records every platform's optional
packages either way, and the setting only decides which ones are installed. No workflow, Dockerfile or
script uses another CPU's npm binary; the worker image installs inside its own build stage, on its own
platform.

Measured on an x86_64 cloud VM with the box's settings (`CI=1`, `package-import-method=copy`, no
`node_modules`, warm store, same lockfile): 15.8–16.8 s before and 12.6–12.9 s after, with
`node_modules/.pnpm` going from 4.5 GB to 3.4 GB.

Considered and not done:

- **Hard links from the shared store.** Putting the work directory on the store's filesystem would let
  pnpm hard-link (14 s instead of 18.9 s in the same test). A hard link is the store's own file, so a job
  that writes into `node_modules` would change it for every later job, fork PRs included. That widens the
  risk noted at the end of this document.
- **pnpm's global virtual store.** pnpm 10.33 ignores `enableGlobalVirtualStore` when `CI` is set; without
  `CI`, a warm install still took 13–14 s.
- **Skipping dependency build scripts.** `--ignore-scripts` saved about 4 s, though the scripts
  themselves run in under 1 s. The four packages in `allowBuilds` (`@ast-grep/cli`, `@bufbuild/buf`,
  `esbuild`, `protobufjs`) set up their native binaries in `postinstall`, and jobs run those tools.
