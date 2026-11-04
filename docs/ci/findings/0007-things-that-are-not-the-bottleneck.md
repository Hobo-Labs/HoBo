---
type: CI Performance Finding
title: "Finding 7: things that are not the bottleneck"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 7: things that are not the bottleneck

- **Checkout** is ~6 s per job (full clone; blobless was slower).
- **Hermetic mise image**: `ci-runner-image` rebuilds only when `mise.toml`/`mise.lock` or the image inputs
  change and pushes the result to GHCR. Otherwise it is a 10–17 s job, mostly checkout. When it does
  rebuild, it failed in 11 s on run 41519610143: Debian's `docker manifest inspect` rejects the pinned
  `debian:bookworm-slim` digest ("unsupported manifest media type
  application/vnd.oci.image.manifest.v1+json"), because that digest is an OCI index carrying attestation
  manifests. [#1644](https://github.com/Hobo-Labs/HoBo/pull/1644) checks the digest against the registry
  API instead. The in-container build then stopped after 6 s on the missing `skopeo`. Behind that,
  `127.0.0.1:5000` inside a job container is the container's own loopback, not the box's registry, and
  the contract check bind-mounted a checkout path the host does not have. `build.sh` now loads the layout
  with skopeo, or without it pushes the layout to the local registry (`mise oci push --image-dir`) and
  `docker pull`s it. A missing GHCR token skips the published-image pull, and a failed GHCR login falls
  back to the native build instead of aborting it. The box's `docker load` rejected the layout
  (`open …/blobs/json: no such file`), because the classic image store reads only docker-save archives.
  It reaches the registry by its bridge address from inside a container, and streams the contract inputs
  into the candidate image.
  `:local` moves only after that contract passes. `skopeo` is also in `system-packages.txt` for the next
  image, and `evaluateCiRunnerContract` checks for it (`IMAGE_CONTRACT_COMMANDS`) only when it runs
  inside a freshly built candidate (`HOBO_CI_RUNNER_CONTRACT=live`). Every job's preflight runs the same
  contract, so requiring it there would refuse jobs on the image that predates it.
  `scripts/test/ci-runner-image-contract.test.ts` pins both halves: the manifest declares it, and the
  live contract checks it. Once the image had it, main run 41578806148 failed at the load:
  bookworm's skopeo pins Docker API 1.22 in its `docker-daemon:` transport, and the box's daemon
  refuses anything below 1.24. skopeo now writes a `docker-archive:` (docker-save format) and
  `docker load` reads that.
- **The image had no browser.** Main push run 41642427527 failed 1 of 2554 tests after 12m44s:
  `@hobo/code` `test/session-control-server.test.ts` launches Chromium, and Playwright looked for
  `~/.cache/ms-playwright/chromium_headless_shell-1234`, which nothing installs. The test's
  `resolveChromiumExecutable()` knew only the arm64 layout under one root and returned `undefined`
  when it found nothing, so Playwright's download hint was the whole error. The base image now
  downloads Playwright's pinned headless shell (revision and version from `playwright-core`'s
  `browsers.json`, sha256 per architecture) into `/opt/pw-browsers`, sets `PLAYWRIGHT_BROWSERS_PATH`,
  and installs the Debian libraries it needs. The live contract renders a page with it
  (`--dump-dom`, which reaches the libraries Chromium opens at runtime, not only the linked ones), and
  `ci-runner-image-contract.test.ts` fails when the pins drift from the installed Playwright or the
  Dockerfile. The helper searches both layouts under `PLAYWRIGHT_BROWSERS_PATH`, `/opt/pw-browsers` and
  `~/.cache/ms-playwright`, and throws with the fix when there is no browser rather than leaving the
  test to whatever Playwright does. The first run of #1673 showed the other half: its gate started at
  13:53:25, before the image job retagged `:local` at 13:55:20, so it tested the old image (no browser,
  and no `tmux`, which the `@hobo/code` git-terminal pane drives through the resident session runtime:
  76 failures reading `tmux availability unknown`). The image now carries `tmux` too (live contract,
  `IMAGE_CONTRACT_COMMANDS`), and `pr-gate` and `main-gate` declare `needs: ci-runner-image` with
  `!cancelled()`, so a run that changes the image inputs tests on the image it built, and a failed image
  build still runs the gate rather than skipping a required check. When the inputs are unchanged the
  image job is a short no-op, which is what the gates now wait for.
- **The git-terminal pane suites waited out their own deadline.** With tmux in the image, run
  41651600798 got past the old failures, but the pane suites ran for 427 s and 596 s, and two tests hit
  the 90 s timeout. tmux was not the cost: the pane only runs `tmux has-session` and never starts a
  server. The test harness read the pane's write count *after* sending a key. A key that opens a prompt
  writes its label inside `stdin.write` itself, so the harness missed that write and polled out a 20 s
  deadline, once per prompt key. The harness now takes the count before each key and resolves on the
  write event, then waits one `setImmediate` tick so the pane can leave `busy`. It has no deadline and
  no fixed gap, so a lost answer fails the test rather than being absorbed into a timeout. The git
  fixture is built once per file and copied per test, with `commit.gpgsign=false` in its own config.
  Both files ran 79 tests in 4.1 s locally, against about 600 s before.
- **A checkout fetch hung for 11.5 minutes.** In run 41659338892 the off-path job's `git fetch
  --depth=2` started at 15:08:41 and was still waiting when the run was cancelled at 15:20:12.
  `git-remote-https` was still alive at cleanup, and the fetch in every other job of that run took
  about 3 s. The step API showed checkout as done and `pnpm install` as running, which was wrong; the
  job log is authoritative. Git has no default transfer timeout, so a stalled connection held one of
  the box's two slots, and the PR impact gate queued for 8 minutes behind it. The workflow now sets
  `GIT_HTTP_LOW_SPEED_LIMIT=1000` and `GIT_HTTP_LOW_SPEED_TIME=30`, the same bound the pins already
  use. A stalled fetch now aborts after 30 s, and `actions/checkout` retries it. The same run's
  contract-guard `pnpm install` also sat for 130 s in linking with nothing to download. That points
  at disk contention on the box rather than the network, and is not addressed here.
- **The cold dev loop is bound by disk, not by the loop.** In run 41663178224 the cold-loop job failed on
  "No space left on device". In run 41667005120 its `pnpm install` took 3m51s (15:45:09 to 15:49:00),
  and the gate step was cut off by the 5-minute job timeout. The loop itself boots in about 15 ms, and
  the script runs in about 1 s. The job installed the whole workspace, copying 4.3 GB out of the store
  (another filesystem, so no hardlinks), then streamed 4.6 GB into the offline container. Both jobs
  that were slow in that run were writing gigabytes to the same disk. The job now installs only what
  the script imports, with `--ignore-scripts`. The stream is 2.24 GB, and an install, unpack and run
  rehearsal takes 12 s locally.
- **The image job rebuilt an image the box already had.** In run 41667005120 a `build.sh`-only change
  started a build that had not finished after 13 minutes. Earlier rebuilds on the same PR took 42–106 s.
  That change also replaced the shared local registry with a per-build one, so the full base was
  pushed again. That change has been dropped. The version tag hashes every image input, so `build.sh`
  now skips the build when `hobo-ci-worker:<version>` is already on the host, and `build.sh` is one of
  the hashed inputs. Preflight prunes only untagged images over a day old, so the layer cache survives.
- **"duplicate" in the worker log is not a stuck dedupe.** The poller reports a queued job as
  `duplicate` when its delivery id (`poll-<job>-<attempt>-q`) is already in the inbox, which is true of
  every job waiting for a slot. With every slot full, `launch()` leaves the lease `reserved`, and the
  next tick retries it. In that run, contract guard and secret scan waited because the two slow jobs
  held the slots, and longest-first admission puts 8–12 s jobs at the back.
- **Vitest inlined the TypeScript compiler.** `typescript/lib/typescript.js` is CJS, but es-module-lexer
  finds module syntax in it, so Vitest's externalization heuristic inlined it. Vite then transformed the
  9 MB file in each worker and logged `Failed to load source map for …/typescript.js` with an ENOENT
  stack, because the `typescript.js.map` it names is not shipped. The root `vitest.config.ts` now lists it
  under `server.deps.external`. `test:unit` locally (four forks): 69.2 s to 64.3 s, transform 31.4 s to
  20.0 s, two warnings to none, with 758/758 files passing both ways.
- **wizer** (componentize-js) is bounded by `HOBO_RELEVANT_CHECK_CONCURRENCY=1` since #1636.
- The non-test parts of `check:all` take ~23 s locally (`test:schema` 10.7 s, `lint:test-deps` 7 s).
- `test:behavior` takes ~120 s locally, most of it one scenario waiting 120 s for `astro dev`.
