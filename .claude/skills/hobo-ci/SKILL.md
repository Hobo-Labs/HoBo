---
name: hobo-ci
description: Use when running or explaining `hobo ci` commands for a repository on GitHub Actions — connecting the HoBo CI relay, previewing where a job would run (`hobo ci route`), moving workflow jobs onto the fleet or behind a relay job (`hobo ci init`), reading runs, logs, signals and failure diagnoses, managing connected machines, adopted runners and provider health, or looking up a HOBO_CI_* error code. Reads before it writes, uses --json, never commits, and says when a command has not landed yet.
---

# HoBo CI commands

HoBo CI routes GitHub Actions jobs. A repository commits a **runner order** in
`.hobo/ci.json` (`runnerOrder`): an ordered list of runner types (the HoBo
fleet, connected machines, GitHub-hosted, hosted providers). A **relay job**
names the runner types one job may use; the order is walked top to bottom and
the job takes the first runner that can run it now, waits for a busy one, or
fails with one sentence saying why. The rules are ADR-0183
(`docs/ci/runner-order.md`) and `packages/ci/RUNNER-ORDER.md`.

For the step-by-step of moving a repository's workflows, use the
`hobo-ci-route-jobs` skill. For "why is CI slow / where did this job run /
why did it fail", use `hobo-ci-insights`. For deploying the hosted relay
itself, use `hobo-deploy`.

## Rules

1. **Read before you write.** Every command that changes something has a
   read-only form (`init --plan`, `route`, `deploy --dry-run`). Run it first
   and show the person what would change.
2. **Use `--json`** when you read the result yourself. Human output may
   change; the JSON fields and the `code` do not.
3. **Never commit, push or open a pull request** unless the person asked.
   `hobo ci init` edits workflow files and commits nothing on purpose.
4. **A failure has a code.** Every `hobo ci` refusal carries a stable
   `HOBO_CI_*` code with its message and what to do. Look it up in the
   generated catalog `docs/ci/errors.md` (source:
   `scripts/ci/error-catalog.mts`) instead of guessing.
5. **Say when something has not landed.** Commands marked *arriving* below are
   named and frozen but may not be in the CLI the person runs. Check
   `hobo ci --help`; if the command is missing, say so and use the fallback
   given, never an invented flag.
6. **Secrets never go on a command line.** The relay credential is
   `HOBO_CI_ACCOUNT_TOKEN` or `HOBO_CI_ACCOUNT_TOKEN_FILE`; never echo either.

## Commands that exist today

| Command | What it does | Writes? |
| --- | --- | --- |
| `hobo ci connect --relay <origin>` (alias `enable`) | Link this repository to a relay; `hobo ci connect github` runs the GitHub App ceremony | The link, after confirmation |
| `hobo ci status` | The relay connection as the CLI sees it | No |
| `hobo ci route` | Answer one relay job against the committed order and print the walk: every step passed over and why. Flags name the label per runner type (`--github ubuntu-24.04`, `--fleet hobo`, `--blacksmith auto`), `--public`, `--fork`, `--event`, `--facts <file.json>` | No; contacts nothing |
| `hobo ci init` | Plan (default, `--plan`) which workflow jobs can move to the fleet; `--apply <jobs>` rewrites their `runs-on`, keeping the old label as a trailing comment | Workflow files, only with `--apply` |
| `hobo ci signals` | Where recent runs lost time or money: waits, flaky and short jobs, extra runs (`--runs 1-100`) | No |
| `hobo ci diagnose [run]` | Why a run's jobs failed, the matched evidence, and whether a re-run is likely to help | No |
| `hobo ci list`, `inspect [run]`, `logs [run]`, `grep <text>` | Read GitHub Actions runs and logs | No |
| `hobo ci rerun [run]` | Retry a completed run (`--wait` to follow it) | Starts a run attempt |
| `hobo ci serve` | Run the relay locally | Local state |
| `hobo ci deploy` | Deploy the hosted relay (see `hobo-deploy`) | Yes |

`hobo ci route` exits non-zero with `HOBO_CI_NO_RUNNER` and the reason when no
runner can take the job, and with `HOBO_CI_RUNNER_ORDER_INVALID` when the
committed `runnerOrder` is broken. A broken order is refused, never replaced
by the default; fix the block or remove it to get the default order
(`fleet`, `machine`, `github`).

## Commands arriving with the relay build

These names are frozen (`RELAY_CI_COMMANDS` in `@hobo/ci`); each lands with
the part of the relay it reads.

| Command | What it will do | Until it lands |
| --- | --- | --- |
| `hobo ci machine` (`connect`, `status`, `pause`, `resume`, `share`, `remove`) | Connect this computer as a runner that takes one job per fresh container; list, pause, share or remove machines | Use an existing self-hosted runner, or the fleet |
| `hobo ci runners` (`list`, `adopt`, `release`) | Add one `hobo-runner-<8 hex>` label to a self-hosted runner GitHub already has, so the order can use it | Name the runner's own label in the order's `machine` input |
| `hobo ci activity` | Every routed job: where it ran, why, and each step passed over (90 days) | `hobo ci route` for a what-if; `hobo ci inspect` for one run |
| `hobo ci usage` | Minutes against the included amount, burn, short jobs, minutes kept off GitHub-hosted runners | `hobo ci signals` |
| `hobo ci performance` | Times by workflow, job and runner type | `hobo ci signals` |
| `hobo ci provider-health` (`clear <provider> <label>`) | Which hosted runner types are skipped as unhealthy, and clear one by hand | Nothing; health is not recorded yet |
| `hobo ci relay` | The relay-job side of a connected relay | `hobo ci status` |
| `hobo ci init --relay [job\|relay]`, `hobo ci init --undo` | Put a relay job in front of each moved job, and take it out again byte for byte | `hobo ci init --apply`; undo by restoring the `# was ...` label |
| `hobo ci rerun <run> --reroute` | Re-run the relay job so the order decides again | `hobo ci rerun` (re-uses the old decision) |

## Frozen names you may see

| Thing | Value |
| --- | --- |
| Relay label (relay mode) | `hobo-relay` |
| Relay job inputs | `fleet`, `machine`, `github`, `blacksmith`, `depot`, `namespace`, `warpbuild`, `ubicloud`, `boat`, `runs-on`, `size`, `first` |
| Relay job outputs | `runner`, `step`, `outcome` (`routed`, `waiting`, `none`), `reason` |
| Files written into a repository | `.github/workflows/hobo-relay.yml`, `.hobo-ci/relay.mjs` |
| Project config | `runnerOrder`, and `relayJobs: { answer, label }` in `.hobo/ci.json` (`answer` is off by default) |

An input left out of a relay job means that runner type is never used for the
job, whatever the order says. `auto` asks for the order's size and becomes the
provider's smallest machine at or above it. A machine never takes a public
repository's job or a fork's pull request.

## When a command fails

1. Read `code` and `message` from the `--json` output.
2. Find the code in `docs/ci/errors.md`; follow its "What to do".
3. If the message says nothing was changed, the command is safe to run again.
   If it says an outcome is uncertain (`HOBO_CI_RERUN_AMBIGUOUS`,
   `HOBO_CI_OPERATION_TIMEOUT`), inspect before repeating anything.
