# ci-runner-balancing

A HoBo reference example: a **credit-aware CI runner dispatcher** that balances
GitHub Actions jobs across **GitHub-hosted runners**, **self-hosted runners**,
and the third-party runner providers curated in
[neysofu/awesome-github-actions-runners](https://github.com/neysofu/awesome-github-actions-runners)
— Namespace, BuildJet, Actuated, WarpBuild, Blacksmith, Ubicloud, RunsOn,
Cirun, Depot, and Cirrus Runners.

CI workflows never hardcode a vendor label. Every job says

```yaml
runs-on: ${{ vars.HOBO_RUNNER_LINUX_SMALL || 'ubuntu-latest' }}
```

and rebalancing is nothing more than patching that repository variable. The
dispatcher picks the target provider by **(a) reported usage against each
provider's budget envelope, then (b) declared billable cost — optimizing free
credits before realtime billing starts** (the `maximize-credits` objective,
[ADR-0071](../../docs/design/adr/01-architecture-core.md#adr-0071)).

The implementation is repurposed from QuickDeployAI's
`monorepo/apps/ci-routing-control-plane` (reactive variable-patching router,
hysteresis, hard-block classification) and `deployment-watcher`'s CI runner
failover (infrastructure-failure regexes), re-cut onto HoBo's dispatcher
vocabulary from the `dispatcher-maximize-credits-contract` and
`execution-host-provider-contract` draft proofs.

## How a pass works

```
RebalanceRequested (command)
  │  read routed variables (GitHub is the source of truth, never mirrored)
  │  collect UsageSnapshots      → meter.UsageRecorded events
  │  scan failed runs            → HardBlockSignal evidence
  ▼
CreditLedgerView@seq (materialized view: effective marginal cost per provider)
  ▼
decide() — pure dispatcher       → dispatch.Decided events (+ credit.Exhausted)
  ▼
apply mode: patch Actions variables → exec.Succeeded events
```

- **Free credits first.** A provider with free-tier headroom has effective
  marginal cost `0` and outranks every paid rate; once headroom is exhausted
  the declared list price takes over, so the cheapest realtime billing wins
  only after every free tier is drained.
- **Budgets bound everything.** A provider at ≥90% of its soft cap is left
  (`direction: "up"`), and a cheaper provider is only returned to below 80%
  (anti-flap hysteresis). Verified spend at the hard cap blocks the provider
  outright.
- **Honest degradation.** Providers without usage APIs report
  `usage_known: false`; routing continues but no decision pretends to be
  spend-verified. Misdeclared cost facts degrade to declared min-cost ranking
  — declared facts are untrusted ranking input, never billing input.
- **The requesting machine is the final backup.** Every track's last rung is
  `hobo-last-resort` — the machine that requested CI, registered on demand as
  an ephemeral self-hosted runner. It ranks after every normal rung
  regardless of its declared zero cost, so the dispatcher fails over to it
  only when every hosted provider is blocked, and returns as soon as one
  recovers. `FAIL_CLOSED` remains only for the case where even the last
  resort is unavailable.
- **Reactive backstop.** Failed jobs whose annotations say *spending limit*,
  *minutes quota*, *no runners available* — or that died before any step
  started — saturate that provider in the ledger regardless of reported
  numbers.

## Layout

| Path | What it is |
|---|---|
| `data-models/runner_balancing.{proto,cue}` | Protobuf records + CUE constraints for every shape below. |
| `src/_generated/runner_balancing_pb.ts` | Generated runtime types (`buf generate data-models --template ../../buf.gen.yaml -o src/_generated`). |
| `src/parse.ts` | The parse boundary: untrusted registry/usage JSON → derived domain types. |
| `src/ledger.ts` | `CreditLedgerView` projection (effective marginal cost per provider). |
| `src/decide.ts` | Pure dispatcher — no I/O, no clock, no provider names. |
| `src/classify.ts` | Runner-infrastructure failure classifier → `HardBlockSignal`. |
| `src/registry.ts` | Default provider registry (all providers above, declared cost facts). |
| `src/adapters/` | GitHub billing, declared third-party usage, Actions variables (the execution adapter), failed-run scanner. |
| `src/rebalance.ts` | The rebalance actor tying command → events → effects. |
| `src/bin/rebalance.ts` | CLI shell (`--mode plan|apply`, `--fixture` for offline). |
| `src/host-runner.ts` + `src/bin/host-runner.ts` | Last-resort host runner: registers this machine as an ephemeral self-hosted runner and drains queued jobs. |
| `fixtures/` | Offline scenarios, replayed by tests and the simulate lane. |
| `contracts/pacts/` | PACT contracts for the billing-read and variable-write boundaries. |

## Run it

```bash
# offline: replay the free-credit rotation scenario (no network, no tokens)
pnpm --filter @hobo/example-ci-runner-balancing rebalance -- \
  --fixture fixtures/free-credit-rotation.fixture.json

# tests
pnpm --filter @hobo/example-ci-runner-balancing test

# live plan against a repository (read-only; needs GITHUB_TOKEN)
HOBO_RB_REPO=owner/repo GITHUB_TOKEN=... \
  pnpm --filter @hobo/example-ci-runner-balancing rebalance

# live apply (patches repo variables; needs a PAT with Variables write)
HOBO_RB_REPO=owner/repo VARS_ADMIN_TOKEN=... \
  pnpm --filter @hobo/example-ci-runner-balancing rebalance -- --mode apply
```

Operator levers (all optional):

| Env | Effect |
|---|---|
| `HOBO_RB_MODE` / `--mode` | `plan` (default) or `apply`. |
| `HOBO_RB_REGISTRY_PATH` / `HOBO_RB_REGISTRY_JSON` | Replace the default provider registry document. |
| `HOBO_RB_PINS` | Comma-separated variables the dispatcher must not flip. |
| `HOBO_RB_OWNER_KIND` | `user` (default) or `org` for the billing API paths. |
| `HOBO_RB_GH_SPEND_USD` / `HOBO_RB_GH_MINUTES` | Override GitHub usage when the billing API is unreachable. |
| `HOBO_RB_USAGE_<PROVIDER>_USD` / `_UNITS` / `_URL` | Declared usage for third-party providers without public APIs. |
| `HOBO_RB_STATE_DIR` | Append events (JSONL) + plan snapshot to this directory. |
| `HOBO_RB_ALLOW_PUBLIC` / `--allow-public` | Permit `host-runner` to register against a **public** repository (refused by default). |
| `HOBO_RB_ENABLE_<PROVIDER>` (repo variable) | Capability guard: makes that provider's rung eligible. |

Third-party rungs are **guarded off until you enable them**: set the repo
variable `HOBO_RB_ENABLE_BLACKSMITH=1` (etc.) only after installing that
provider's GitHub App or registering its runner pool. The `self-hosted` rung
is guarded by `HOBO_RB_ENABLE_SELF_HOSTED`. All third-party prices and free
tiers in `src/registry.ts` are `COST_TRUST_DECLARED_UNVERIFIED` snapshots of
public pricing pages — override them with your negotiated rates.

## Last resort: run CI on the machine requesting it

When GitHub refuses to schedule hosted jobs (spending limit reached,
included minutes exhausted, payment failure) and no third-party provider is
enabled, the dispatcher fails over the track to the `hobo-last-resort`
label. Jobs then queue until the requesting machine serves them:

```bash
# 1) flip the track (the rebalance pass does this itself when it can run;
#    from a blocked account, run it locally)
HOBO_RB_REPO=owner/repo VARS_ADMIN_TOKEN=... \
  pnpm --filter @hobo/example-ci-runner-balancing rebalance -- --mode apply

# 2) serve the queued jobs from this machine as an ephemeral runner
HOBO_RB_REPO=owner/repo HOBO_RB_RUNNER_TOKEN=<repo-admin PAT> \
  pnpm --filter @hobo/example-ci-runner-balancing host-runner
```

The host runner downloads the official `actions/runner` build for this
platform (Linux/macOS), registers **ephemeral** (one job per registration,
auto-deregisters), serves the `hobo-last-resort` label, and re-registers
while queued runs remain (`--once` / `--max N` to bound it). GitHub does not
bill self-hosted minutes, so the last resort also costs $0 in Actions spend.
It installs into `--dir`, else `HOBO_RB_RUNNER_DIR`, else `last-resort-runner/`
in the HoBo home (`resolveHoboHome` from `@hobo/core/hobo-home`: `HOBO_HOME`,
else `~/.hobo`).

**Security posture:** a registered runner executes the repository's workflow
code on your machine. Use it for your own repository and branches only —
never expose it to untrusted fork PRs — and prefer the default ephemeral
mode so nothing lingers after the queue drains.

This is **enforced, not just advised**: `host-runner` reads the repository
record before it installs or registers anything and refuses outright when the
repository is public (`HOST_RUNNER_PUBLIC_REPO_REFUSED`), naming fork
pull-request workflows explicitly when they are enabled. It also fails closed
when the repository's visibility cannot be read at all
(`HOST_RUNNER_VISIBILITY_UNKNOWN`) — "we could not tell" is not "it is fine".
Override only if you accept the risk:

```bash
# refuses by default on a public repo; opt in deliberately
HOBO_RB_ALLOW_PUBLIC=1 pnpm --filter @hobo/example-ci-runner-balancing host-runner
#   ... or --allow-public
```

## Deferring the CI work itself (Turborepo-style local gate)

Some requesting machines cannot register a runner at all — sandboxed agent
sessions, for example, sit behind an egress proxy that forbids the GitHub
Actions API entirely. For those, and for anyone who wants verification
before any runner is involved, `local-gate` inverts the relationship the
way Turborepo remote caching does for builds: **the requesting machine runs
the CI work; the hosted lane becomes a replay of work already done.**

```bash
pnpm --filter @hobo/example-ci-runner-balancing local-gate -- --base origin/main
```

runs the exact suite the hosted pr-gate job runs (`pnpm agent:check` against
the base, the Turbo affected-package lanes, `pnpm run build:packages`),
streams output, folds the results into `golden.Ran` / `golden.Passed`
events plus a markdown verdict (written to `HOBO_RB_STATE_DIR` when set),
and exits non-zero on any gate failure. The resilience ladder is therefore:

1. **Hosted providers**, budget-routed by the dispatcher.
2. **Ephemeral last-resort runner** on a trusted requesting machine
   (`host-runner`) — CI jobs still run under GitHub's orchestration.
3. **Local gate** on any requesting machine — the CI *work* runs and is
   published as evidence even when GitHub cannot schedule anything.

## Dogfooding in this repository

HoBo routes its own CI through this example: every non-matrix Linux job in
[`.github/workflows/`](../../.github/workflows/) consumes
`vars.HOBO_RUNNER_LINUX_SMALL` with an `ubuntu-latest` fallback, and
[`rebalance-runners.yml`](../../.github/workflows/rebalance-runners.yml) runs
the CLI on a daily schedule (plan always; apply when `VARS_ADMIN_TOKEN` is
configured). The rebalance controller itself stays pinned to `ubuntu-latest`
so it can never be stranded by the variable it manages. See
[`docs/design/ci-runner-balancing-example.md`](../../docs/design/ci-runner-balancing-example.md)
for the full dogfood record and rollout posture.

## How this maps to HoBo's architecture

Records live protobuf-first in `data-models/runner_balancing.proto` with CUE
constraints in `runner_balancing.cue`; runtime record types are the generated
ones in `src/_generated/runner_balancing_pb.ts`. Following **parse, don't
validate**, untrusted registry and usage documents cross a single parse
boundary (`src/parse.ts`) and come out as **derived types**
(`ParsedRegistry`, generated records) whose invariants mirror the CUE
constraints, so invalid values are unrepresentable downstream. JSON fixtures,
PACT inputs, and GitHub HTTP responses likewise cross explicit JSON/shape
parsers before use; optional fields are added only when present.

The flow is event-driven CQRS: `RebalanceRequested` is the **command**; the
rebalance **actor** collects usage and appends `meter.UsageRecorded`,
`credit.Exhausted`, `dispatch.Decided`, and `exec.Succeeded` **events** to the
**event store** (JSONL when `HOBO_RB_STATE_DIR` is set); the
`CreditLedgerView` is the **materialized view** (a **projection** over usage
and hard-block evidence, pinned at `seq` so decisions replay
deterministically); and the `RebalancePlan` **snapshot** in the **read store**
answers "what is routing where right now" without touching the write path.
The actor never mutates the read model directly. The billing-read and
variable-write service boundaries are pinned by the executable PACTs in
`contracts/pacts/`, exercised by `contracts/consumer/`.

## Scope boundary

This is a reference example, not a hosted service with an SLA
([example-apps](../../docs/design/example-apps.md) proof modes: contract
tests + reference fixtures + a simulated live lane). It does not implement
billing (HoBo charges no money, ADR-0064), provider SDK integrations beyond
declared usage, reservation-CAS double-spend protection
(`dispatcher-reservation` draft proofs), or Windows/macOS/GPU tracks — those
slot in as additional `RunnerTrack` records.
