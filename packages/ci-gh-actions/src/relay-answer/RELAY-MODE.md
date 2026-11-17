# Relay mode

In relay mode ([ADR-0183](../../../../docs/design/adr/runner-order.md)) a relay
job asks for the label `hobo-relay`, and a HoBo node answers it over the
runner protocol. No runner program starts, so the relay job runs no job code
and bills no runner minute. The decision is the same one job mode makes:
`answerRelayJob` from `@hobo/ci` (see [`packages/ci/RELAY-JOB.md`](../../../ci/RELAY-JOB.md)).

**It is built, not proven.** Everything here is tested against the GitHub
simulator (`test/support/github-simulator/`). No relay has answered a job
from GitHub's runner service yet, so the channel stays behind its flag until a
live run is linked.

## Files

| File | What it holds |
| --- | --- |
| [`answerer.ts`](answerer.ts) | `createRelayAnswerer`: answer one queued relay job, the signed webhook that wakes it, the rescue poll and the leftover-runner sweep |
| [`store-facts.ts`](store-facts.ts) | `StoreRouteFacts`: the facts the walk uses, from the relay's own records |
| [`ci-file.ts`](ci-file.ts) | `GithubCiFile`, `GithubCiOrderSource` and `parseRelayJobs`: the one file relay mode reads |

## Answering one job

For a queued job whose only label is the relay label:

1. Answering must be on twice: for the node (`relayJobs.answer` in its own
   configuration) and for the repository (`relayJobs.answer` in its
   `.hobo/ci.json`, whose `label` must be the job's label). With the node's
   flag off the answerer makes no request and registers nothing.
2. When the node is part of a mesh, it takes the mesh turn for the job id
   (`MeshCoordinator.shouldStart`), so one node answers. A node that is not
   first waits its turn and answers on a later poll if the job is still queued.
3. It checks GitHub still has the job queued, so a redelivered webhook costs
   no runner. Only a readable status or a 404 counts as an answer: a job GitHub
   says is gone is remembered and never asked about again, while a 5xx, a rate
   limit or an unreadable body skips the job as `read-failed` and the next poll
   asks again.
4. It creates a one-job runner named `hobo-relay-<run>-<job>-<try>` on the
   job's repository, or on the organization when the repository refuses
   (403 or 404). A second node asking for the same name gets a 409 and stops,
   which fences the job even when the mesh's claim store is unreachable. A
   runner left behind by a node that died fences the job only until the sweep
   removes it (see below).
5. It opens a session, waits up to four minutes for GitHub to offer a job,
   answers it with `answerRelayJob` (mode `relay`), completes it, closes the
   session and deletes the runner.

GitHub hands a runner any waiting job with its label, oldest first, not
necessarily the one that woke the answerer. A job it was offered instead is
answered all the same, and the answerer starts again for the original, at most
four runners in all. The job that woke the answerer is recognised by its run
and attempt, and by its id in the workflow file; when the queue shows a
display name instead (a job with `name:` or a matrix leg), GitHub is asked
whether the original is still queued once the offered job is completed.

A runner created on the organization can be offered a relay job of any
repository there. Such a job is answered only as its own repository asks:
its `.hobo/ci.json` must turn `relayJobs.answer` on for the label and the node
must serve its account, whose facts and journal the answer then uses.
Otherwise the job fails with a sentence saying relay mode is not on for that
repository; it is never routed with another account's machines or spend.
A known limit of this fallback: in a mesh where another node serves that
repository's account, this node still fails the job, since it cannot hand an
offer over. The failure says to run the job again, so that node can answer it.

A job that asked for the relay label but names no relay
input, and is not made only of check steps, fails with a sentence saying a
relay never runs a job's steps.

## Rescue and sweep

`rescue(connections)` reads each connected repository's queued and in-progress
runs and their jobs, as the job poller does, and answers every queued relay
job it finds, four at a time (`RELAY_RESCUE_CONCURRENCY`), since each can
wait up to four minutes for an offer. A relay job whose `queued` webhook never
arrived is answered on the next poll. The poller starts the next rescue only
when the last one has returned; a job already being answered is skipped as
`in-flight` either way.

`sweep(connections)` deletes `hobo-relay-*` runners, on the repository or its
organization, that are not busy and either belong to a run that has ended or
have been seen offline by two sweeps at least `RELAY_STALE_RUNNER_MS` (one
minute) apart. A run has ended only on proof: GitHub reads it as `completed`,
or a runner registered on one repository names a run that repository does not
have. An organization runner whose run is in none of the repositories this
node serves may be a peer node's, so only the offline path can remove it. A live node's runner is online while it waits for an offer, and
the node's own runners are never swept, so this removes only runners a node
left when it died or when its delete failed. Their fixed names would
otherwise fence their jobs for good.

## Facts

`StoreRouteFacts` reads, for the job's account:

| Part | From |
| --- | --- |
| Fleet room | The lease ledger: on when the node has fleet slots, taking while fewer leases are active than slots, isolated only when the node says each job gets its own machine |
| Machines | The machine registry: every advert, online when renewed within 90 seconds; the caller says which owners can read the repository |
| Spend | The spend reader (the ledger first, list prices second), from the first instant of the UTC month |
| Health | The provider health store: runner types tripped and not due a trial |
| Minutes | The minutes reader, for the repository's owner |

A read that fails leaves its part unmeasured and reports a warning. It never
fails the decision.

## What it reads

Of a repository it reads `.hobo/ci.json` and nothing else: at the default
branch, or at a pull request's base branch, never at the commit a run is
testing, so a branch cannot route its own jobs or turn relay mode on for
itself. Beyond that it reads job and run status, lists runners and creates and
deletes its own one-job runners. It asks for no log, secret, variable or
other content (gauntlet case X01), and nothing it loads can start a process
(case X03, `test/relay-answer-safety.test.ts`).

The project schema (`schema/ci-project.schema.json`, `src/project-schema.ts`)
accepts the `relayJobs` block, and the `checks` block runner-less checks read,
with the same strict shapes, so a project that sets them still loads in
`hobo ci serve`.

## Tests

`test/relay-answer.test.ts` runs the T2 cases against the simulator: R01 (an
answer within five seconds of the webhook, on no runner), R04 (nothing fits:
the relay job fails with the reason and the job behind it is skipped), R05
(a busy machine is waited on and cancelling frees the job), R06b (the fleet
takes a public repository's job only when it isolates), R13 (a lost webhook
is rescued), R16 (with the first node down, the second answers exactly once)
and X01. It also covers a failed read of the job (answered on the next
rescue), a leftover runner from a node that died (swept, then the job is
answered), a peer's online organization runner for a repository this node
does not serve (kept), an organization runner offered another repository's job (failed
when that repository left relay mode off, answered with its own account when
it turned it on) and an original job whose display name is not its id. `test/relay-answer-facts.test.ts` covers the facts and the file.
The parity scenarios for R01, R13, R16, X01 and X03
(`features/hobo-ci-parity/steps/relay-mode.steps.ts`) run the same answerer
against the simulator; the X03 one also replaces Node's process-starting
functions for the answer and checks none was called.

The GitHub boundary is held in two hand-authored pacts:
[`contracts/relay-answer.pact.json`](../../contracts/relay-answer.pact.json)
for the REST calls the answerer makes and
[`contracts/relay-answer-webhook.pact.json`](../../contracts/relay-answer-webhook.pact.json)
for the `workflow_job` deliveries it receives.
`contracts/relay-answer.consumer.test.ts` drives the answerer through every
interaction of both.

The run that would prove relay mode: turn `relayJobs.answer` on for one
repository on a deployed relay, push a workflow whose relay job asks for
`hobo-relay`, and link the run showing the relay job completed with no billed
minute and the job behind it on the runner the relay named.
