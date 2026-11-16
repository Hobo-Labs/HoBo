# Relay job

A relay job is the small job a workflow puts in front of the real one to ask
which runner it should run on. Its answer is a `runner` output the next job
reads in `runs-on`. This file describes the seams that answer it; the walk
itself is in [RUNNER-ORDER.md](RUNNER-ORDER.md) and the decision record is
ADR-0183 ([`docs/design/adr/runner-order.md`](../../docs/design/adr/runner-order.md)).

There are two ways to answer one, over one engine:

| Mode | Who answers | How the answer gets back |
| --- | --- | --- |
| `job` | A vendored evaluator running as the relay job on a GitHub-hosted runner | The job's own outputs |
| `relay` | A HoBo node that claims the job, labelled `hobo-relay`, over the runner protocol | It completes the job with outputs, and no runner minute is billed |

## Records

The records are in [`data-models/relay_job.proto`](data-models/relay_job.proto)
with rules in [`data-models/relay_job.cue`](data-models/relay_job.cue). Each
has a parser in [`src/runner-order/relay-job.ts`](src/runner-order/relay-job.ts)
that returns the generated record, checked and frozen.

| Record | Holds |
| --- | --- |
| `RelayJobMessage` | The job and plan ids, repository, run id and attempt, job id, event, actor ids, `private`, `fork`, the workflow ref, the relay's inputs and the job's steps |
| `RelayJobAnswer` | The job and plan ids, `succeeded` or `failed`, outputs and annotations. A failed answer always carries an annotation saying why |
| `RunnerRouteEvent` | `runner.route.Requested` or `runner.route.Decided`, the account, the time, the request, the decision (on `Decided` only), the mode and the node that answered |
| `MachineAdvert` | A connected machine: its label, labels, OS, architecture, slots, pause, sharing, owner, last seen, signing key and isolation (`container` or `host`) |
| `ProviderHealthRecord` | A hosted runner type's recent outcomes, trip time, back-off and trial |
| `RunFact`, `JobFact`, `StepFact` | One run attempt, field for field what the insight reports read |

`insightRunOf` and `runFactOf` convert a stored run both ways,
`providerHealthOf` and `providerHealthRecord` do the same for health, and
`machineCandidate` gives the walk a machine from its advert plus the two facts
an advert cannot hold: whether it is online and whether its owner can read the
repository.

## Names every part agrees on

| Thing | Value | Constant |
| --- | --- | --- |
| Relay label | `hobo-relay` | `RELAY_LABEL` |
| Inputs | one per runner type, then `size` and `first` | `RELAY_JOB_INPUTS` |
| Outputs | `runner`, `step`, `outcome`, `reason` | `RELAY_JOB_OUTPUTS` |
| Files written into a repository | `.github/workflows/hobo-relay.yml`, `.hobo-ci/relay.mjs` | `RELAY_WORKFLOW_FILE`, `RELAY_EVALUATOR_FILE` |
| Check steps | a `uses:` ending in `/checks/pr-title` or `/checks/lint` | `RELAY_CHECK_STEP_SUFFIXES` |
| Events | `runner.route.*`, `machine.*`, `job.retried`, `check.completed` | `RELAY_EVENT_TYPES` |
| Commands | `hobo ci machine`, `runners`, `activity`, `usage`, `performance`, `provider-health`, `relay` | `RELAY_CI_COMMANDS` |
| Read API | `/v1/accounts/self/{runner-order,routes,machines,runs,signals,job-times,usage}` and `/runs/{id}/{attempt}/jobs` | `RELAY_READ_API_PATHS` |
| MCP tools | `get_runner_order`, `explain_route`, `list_route_decisions`, `list_machines`, `get_signals`, `get_job_times`, `get_run_failures`, `get_usage` | `RELAY_MCP_TOOLS` |

## Ports

[`src/runner-order/ports.ts`](src/runner-order/ports.ts) names every way the
engine reads or writes something outside itself:

| Port | What it answers |
| --- | --- |
| `RunnerOrderSource` | The committed order of a repository, or the default with the parser's sentence when it does not parse |
| `RouteFactsSource` | What is true for one request now. A part not measured is left out |
| `RouteJournal` | Keeps each route event once per relay job and event type, and reads them back newest first |
| `MachineRegistry` | Lists, adds, pauses, shares and removes machines |
| `ProviderHealthStore` | Keeps each hosted runner type's health and says which are unhealthy now |
| `MinutesReader`, `SpendReader` | The billing reads; undefined or a missing entry means unmeasured |
| `InsightStore` | Keeps run attempts and reads them back newest first |
| `RelayChecks` | Answers a job made only of check steps, or leaves it to be routed |

[`src/runner-order/testing.ts`](src/runner-order/testing.ts), exported as
`@hobo/ci/runner-order/testing`, holds an in-memory fake of each port and one
conformance function per port (`routeJournalConformance(make)` and so on).
A conformance function throws a `PortConformanceError` naming the first rule a
port breaks. The fakes pass their own; a real port's test calls the same
function with its own factory.
