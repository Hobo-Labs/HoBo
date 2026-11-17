# macOS machines

A Mac can be a machine that runs jobs routed to it, the same way a Linux computer can (see [the machine worker](../MACHINE-WORKER.md)). This is part of the runner-order work recorded in [ADR-0183](../../../../../docs/design/adr/runner-order.md).

## How a Mac connects

A Linux machine runs each job in a fresh container by default. A Mac has no such default, so `hobo ci machine connect` on a Mac stops and asks for one of two choices:

| Flag | Where each job runs | What the advert says | Labels a job can ask for |
| --- | --- | --- | --- |
| `--host` | On the Mac, as the user who connected it | `host` | `self-hosted`, `macOS`, and `ARM64` or `X64` |
| `--vm` | In its own Linux VM, made for the job and deleted after it, through Apple's `container` tool | `container` | `self-hosted`, `Linux`, `ARM64` |

`--host` and `--vm` cannot both be given. The connect message says plainly when jobs run on the Mac itself.

`--vm` needs Apple silicon and Apple's [`container`](https://github.com/apple/container) tool with its services running (`container system start`). The tool runs Linux containers as lightweight virtual machines on a Mac and is built for macOS 26 or later (its README, read 2026-11-17). When `--vm` is asked for and the tool is missing, stopped, or the Mac has an Intel CPU, the command fails with the reason. It never falls back to the host.

A job that runs in a VM is a Linux job, so the advert carries the VM's labels, not the Mac's. A workflow that wants macOS tools asks for `macOS` and needs a Mac connected with `--host`.

## The runner program

Host jobs run the official `actions/runner` macOS archive at the version the Linux path pins (`RUNNER_VERSION`). Each archive has its SHA-256 written in `runner.ts`, taken from the [v2.338.2 release notes](https://github.com/actions/runner/releases/tag/v2.338.2) on 2026-11-17; the same notes give the Linux checksums `bootstrap.ts` already pins. The archive is downloaded once, checked before every job, unpacked fresh for each job and removed after it. A download that does not match its checksum is refused before anything unpacks it. A version bump is a commit.

A host job gets only the runner's environment allow-list and its one-job configuration in `ACTIONS_RUNNER_INPUT_JITCONFIG`; the CLI's GitHub token never reaches it.

A VM job runs exactly as a Linux container job does: the job image's start script downloads the pinned Linux arm64 runner and checks its SHA-256, the one-job configuration is written into the VM over stdin, and the VM gets only the runner's download and the proxy settings.

## Files

| File | Holds |
| --- | --- |
| `platform.ts` | `machineConnectPlan`: the OS, CPU, isolation and labels a computer connects with, or why it cannot as asked |
| `runner.ts` | The pinned macOS archives and `pinnedMacosRunnerProgram` |
| `apple-container.ts` | The status probe, a container driver over Apple's tool, and the `--vm` executor |
| `testing.ts` | A fake of Apple's tool whose runner is a test function; nothing in it starts a process |

## What is proven and what is not

Gauntlet case M12 runs against the GitHub simulator with a fake host process and a fake of Apple's tool: a Mac connected with `--host` advertises the macOS labels, a relay job asking for `macOS` routes to it, and the job runs on its one-job runner from the pinned macOS archive. Nothing has run on a real Mac yet. Until a run is linked, these are built, not proven:

- `hobo ci machine connect --repo <owner/name> --host` on an Apple silicon Mac, taking one job from a workflow with `runs-on: [self-hosted, macOS, ARM64]` routed to it;
- the same on an Intel Mac;
- `--vm` on an Apple silicon Mac with macOS 26 and Apple's tool running, taking one `Linux` job in a VM that is deleted after it.
