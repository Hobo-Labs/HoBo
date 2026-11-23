# Relay job

A relay job is the small job a workflow puts in front of the real one to ask
which runner it should run on. Its answer is a `runner` output the next job
reads in `runs-on`. This file describes the seams that answer it; the walk
itself is in [RUNNER-ORDER.md](RUNNER-ORDER.md).

A HoBo node answers one (mode `relay`): it claims the job, labelled
`hobo-relay`, over the runner protocol and completes it with outputs, and no
runner minute is billed. Routing happens in HoBo CI, never in a workflow:
HoBo ships no workflow that runs a routing or evaluator job, and no command
writes one into a repository. The only HoBo CI change a workflow gets is
`runs-on` set to a HoBo label.

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
| Project config | `relayJobs: { answer, label }` in `.hobo/ci.json`, `answer` false unless written | `DEFAULT_RELAY_JOBS`, `RelayJobsConfig` |
| Inputs | one per runner type, then `size` and `first` | `RELAY_JOB_INPUTS` |
| Outputs | `runner`, `step`, `outcome`, `reason` | `RELAY_JOB_OUTPUTS` |
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

Journal reads are account-scoped, bounded and newest first; a redelivery keeps
the first event for the same relay job and event type. Machine pause and sharing
changes reject unknown IDs, while removing an unknown machine is a no-op. An
unreadable minutes total or missing provider spend entry means unmeasured usage,
and a step with a spend limit refuses unmeasured spend. `LedgerSpendReader`
answers $0 for a provider with nothing charged this month, leaves out a
provider with a job it cannot price, and answers nothing when a source cannot
be read.

## Answering a relay job

`answerRelayJob(message, deps)` in
[`src/runner-order/answer.ts`](src/runner-order/answer.ts) is the one function
a relay node calls. In order, it:

1. Reads the message. One it cannot read still gets a failed answer naming the
   broken rule, so the job is completed rather than left queued.
2. Gives a job containing check steps to `deps.checks`. If no handler answers
   that job, it fails instead of reporting success for checks that did not run.
3. Journals `runner.route.Requested`.
4. Asks the order source for the repository's order at the workflow's ref. A
   broken order is refused with the parser's sentence and no facts are read.
5. Reads the job's own `size` (the vCPUs `auto` asks for) and `first` (a runner
   type to try first). A value it cannot read fails the job with one sentence.
6. Gathers facts, walks the order and journals `runner.route.Decided` with the
   decision.
7. Maps the decision to an answer:

| Decision | Conclusion | Outputs | Annotation |
| --- | --- | --- | --- |
| `routed` | `succeeded` | `runner`, `step`, `outcome`, `reason` | A warning when an unhealthy runner type took the job because nothing else could |
| `waiting` | `succeeded` | The busy step's label as `runner` | A notice that the job is queued |
| `none` | `failed` | `outcome: none` and the `reason` | An error with the reason |

The job behind a failed relay is skipped by GitHub, so it never waits for a
runner that will not come. A redelivered relay job is journaled once: the
journal keeps one entry per job id and event type.
