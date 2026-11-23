---
type: CI Performance Finding
title: "Finding 159: preflight downloaded tools the job never ran"
description: "On hobo-trunk, ci-runner-preflight spent 8–15 minutes of each 20-minute job downloading python, betterleaks and syft at about 15 KiB/s. Those tools are now job-scoped, preflight takes seconds, and three job limits drop to twice their longest measured run."
tags: [hobo, ci, performance, preflight, mise, runner-image, timeouts]
---

# Finding 159: preflight downloaded tools the job never ran

## Measurements

On 2026-11-22, release and Fabric jobs on `hobo-trunk` runners hit their 20-minute limit before their real work. Three attempts of the release run on one pull request failed this way, on six runners.

| Job | `ci-runner-preflight` | Job limit |
| --- | ---: | ---: |
| Release contract + affected OCI images | 7 min 45 s | 20 min |
| Release Freight realize proof (offline) | 15 min 8 s | 20 min |
| Same jobs in a merge-group run on a GitHub-hosted machine | 5 s | 20 min |

The preflight log names the cause. The fleet image lacked python 3.12.16 (pinned that day), betterleaks 1.10.1 and syft 1.56.0. The blanket `mise install --locked` downloaded all three from `release-assets.githubusercontent.com` at 15–19 KiB/s, and mise warned that the download was very slow. Only state-machine verification uses python, only the two secret scans use betterleaks, and the release attestation step already installs syft itself.

## Fix

`betterleaks`, `python` and `syft` are job-scoped. A job names the ones it runs with the preflight action's `tools` input. Preflight neither installs nor checks a job-scoped tool the job does not name. It always installs and checks the core tools. It also turns off mise's auto-install for later steps, so a step that needs an unnamed tool fails at once instead of downloading it. `build.sh` still checks a candidate image for every tool. See [the runner image README](../../../packages/ci-gh-actions/deploy/ci-runner/README.md).

After the change, preflight took 3–7 s on every finished job of the pull request that carried it, on GitHub-hosted machines and the `hobo-runner` pool.

## Job limits

With preflight down to seconds, a job's limit can follow its own work. From the last 40 successful runs of each workflow, each job with at least 20 samples now has a limit of twice its longest successful run, rounded up to five minutes and kept above its own step limits:

| Job | Longest of n runs | Limit before | Limit now |
| --- | ---: | ---: | ---: |
| Scripts tests build | 5 min (35) | 20 min | 10 min |
| Scripts tests | 3 min (140) | 20 min | 15 min (a 12-minute step) |
| PR off-path checks | 3 min (20) | 20 min | 10 min |

Live data engines and state-machine verification keep 20 minutes, which their step budgets need. The release Freight realize proof also keeps 20 minutes: on `hobo-trunk` a cold build of the hobo CLI alone ran past six minutes, and the whole job past ten, which the GitHub-hosted samples did not show. Most samples ran on GitHub-hosted machines. Re-measure on `hobo-trunk` once its image carries the current pins.
