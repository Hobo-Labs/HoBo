# Runner order

A runner order is an ordered list of runner types. A job takes the first one
that can run it now. This file describes the model in
[`src/runner-order/`](src/runner-order/index.ts); the records are in
[`data-models/runner_route.proto`](data-models/runner_route.proto).

It answers a different question from [allocation routing](README.md#apply-routing-and-budgets).
Allocation routing ranks the offers an account has published by what a job
would cost and reserves budget for the winner. A runner order is the
preference a person writes down: "my machines, then Blacksmith while it is
under $100 this month, then GitHub-hosted". Nothing is ranked. The order is
walked as written.

## The pieces

| Piece | What it is | Where |
| --- | --- | --- |
| Runner order | The ordered steps, a retry policy, whether unhealthy runner types are skipped, and the size `auto` means | `RunnerOrder`, `parseRunnerOrder` |
| Relay request | What one relay job allows: for each runner type, the label the job would ask it for | `RunnerRouteRequest`, `relayInputs` |
| Facts | What is true right now: fleet room, machines, minutes used, money spent, tripped runner types | `RouteFacts` |
| Decision | Where the job goes and every step passed over on the way | `RunnerRouteDecision`, `decideRunnerRoute` |

All of it is pure: no clock, network or store. A host gathers the facts and
calls `decideRunnerRoute(order, request, facts)`.

## Steps

| Step | Runs the job on | Label the job asks for |
| --- | --- | --- |
| `fleet` | The HoBo isolated fleet: a one-job runner in a fresh container or sandbox | The fleet label (`hobo`, `hobo-trunk`) |
| `machine` | A connected workstation, or a self-hosted runner registered before HoBo was | The machine's own label |
| `github` | GitHub-hosted runners | A GitHub label such as `ubuntu-24.04` |
| `blacksmith`, `depot`, `namespace`, `warpbuild`, `ubicloud`, `boat`, `runs-on` | That provider's runners, brought by the provider's own GitHub App | One of the provider's labels |

Each step appears once. `github` may appear twice, once with a minutes limit
and once without, so "GitHub while under 80% of the included minutes, then
machines, then GitHub regardless" is one order.

The default order is `fleet`, `machine`, `github`.

```json
{
  "steps": [
    { "key": "machine" },
    { "key": "blacksmith", "spendLimitUsd": 100 },
    { "key": "github", "minutesLimitPercent": 80 },
    { "key": "github" }
  ],
  "retry": { "enabled": true, "runner": "other", "max": 1 },
  "autoSizeVcpus": 4
}
```

## What a relay names

A relay names one input per runner type the job may use. A type it leaves
out is never used for that job, whatever the order says, so a workflow cannot
be moved onto capacity its author did not write down. A type the relay names
that the order leaves out is never tried either, and the decision lists it
under `notInOrder`.

An input is a label, or `auto`. `auto` asks for the order's size
(`autoSizeVcpus`, 2 when unset) and becomes the provider's smallest machine
at or above it. A provider with no machine that large is passed over as
`no_size`. A relay with no inputs at all means every runner type at that
size.

The label families are in `RUNNER_PROVIDER_CATALOG`, each with the vendor
page it was read from and the day it was read. They are Linux x64 on the
vendor's current Ubuntu image; anything else is named by writing the label
out. No `auto` label is ever `ubuntu-latest`.

## The walk

Steps are tried top to bottom. A step is passed over, with a reason, when:

| Reason | Meaning |
| --- | --- |
| `not_configured` | The relay did not name this runner type |
| `public_repository` | A machine never takes a public repository's job; neither does a provider that is opt-in for public repositories until the owner has turned it on |
| `fork_pull_request` | A machine never takes a run whose head is a fork |
| `needs_isolation` | The repository is public or the run comes from a fork, and the fleet is not set up to isolate such jobs |
| `no_size` | `auto` asked for a size this runner type does not have |
| `too_many_labels` | A fleet, GitHub or provider step was given more than one label |
| `not_provider_label` | The label is not one of this provider's |
| `minutes_limit` | The account has used the step's share of its included Actions minutes |
| `minutes_runway` | The included minutes would run out within two hours at the measured burn |
| `spend_limit` | The account has spent the step's monthly limit at this provider |
| `provider_unhealthy` | This runner type has stopped starting jobs |
| `fleet_off` | The fleet does not serve this repository |
| `fleet_full` | The fleet has no room right now |
| `no_machine` | No online machine has the labels |
| `machine_not_shared` | Machines fit, but none is shared with whoever started the run |
| `machine_paused` | The machines that would take it are paused |
| `machine_full` | The machines that would take it are all busy |

A measurement that is missing never blocks a step. Refusing a runner because
a billing read failed would stop CI over a number nobody saw.

## When no step takes the job

1. A hosted runner type passed over only as `provider_unhealthy` takes the
   job after all (`unhealthyFallback`). A slow runner beats no runner.
2. Otherwise a step that would have taken the job but is busy (`fleet_full`,
   `machine_full`) is waited on. The outcome is `waiting`, the job is given
   that step's label and queues on GitHub as it would on any self-hosted
   runner. The first busy step in the order wins.
3. Otherwise the outcome is `none` and `reason` is one sentence a person can
   act on. The relay job fails with it instead of leaving a job queued for a
   runner that will never come.

## Machines

A machine is someone's computer, so the rules are about whose jobs it runs
before they are about speed (`chooseMachine`):

- It must be online, hold every label the relay asked for (case ignored),
  and, when it was registered on one repository, be asked by that repository.
  Its owner must still be able to read the repository on GitHub.
- Shared with `only_me`, it takes a job only when its owner both started and
  triggered the run. That leaves out bots, schedules and someone else's
  re-run.
- Shared with `anyone`, it may run another person's job.
- It must be unpaused and have a free slot.

Among the machines left, the starter's own come first, then whichever was
picked longest ago.

## Provider health

A hosted provider brings its own runner, and nothing reports when that stops
working: the label is still valid and the job just waits. So the record is
kept from the outside (`recordProviderOutcome`). A job with no runner ten
minutes after it queued is a miss. Three misses in a row inside thirty
minutes trip the runner type. After ten minutes one job is let through as a
trial; a missed trial doubles the wait, up to an hour; any job that gets a
runner clears the record. `skipUnhealthy: false` turns the skipping off.

## Retries

A routed job is run again only when the failure was not its own doing
(`retryKind`): the runner never reached a step (`runner_start`), the machine
disconnected while the job was on it (`machine_lost`), or GitHub reported
losing the runner (`runner_lost`). A failing test is never retried here.

The policy's `runner` decides where the retry goes: `same` puts the failed
step first, `other` puts it last, `any` leaves the order as written. A run is
retried at most `max` times (1 or 2), an account at most 100 times a day, and
a run with more than one relay is left alone.

## What is not here

- The host that gathers facts and records decisions. `decideRunnerRoute` is
  called by the `hobo ci route` command today; no relay endpoint or route job
  walks an order yet.
- Billing reads. `MinutesUsage` and the monthly spend are inputs.
- Prices. The financial models are in [`src/fleet/models.ts`](src/fleet/models.ts).

## Gates

- Protobuf: `data-models/runner_route.proto`, generated into
  `src/_generated/runner_route_pb.ts` (`pnpm run codegen:check`).
- CUE: `data-models/runner_route.cue`, with fixtures under
  `data-models/fixtures/runner_route/`. `test/runner-order-catalog.test.ts`
  fails when the skip reasons or the hosted providers in CUE and in code
  differ.
- Tests: `test/runner-order-*.test.ts`.
