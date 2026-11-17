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
   no runner.
4. It creates a one-job runner named `hobo-relay-<run>-<job>-<try>` on the
   job's repository, or on the organization when the repository refuses
   (403 or 404). A second node asking for the same name gets a 409 and stops,
   which fences the job even when the mesh's claim store is unreachable.
5. It opens a session, waits up to four minutes for GitHub to offer a job,
   answers it with `answerRelayJob` (mode `relay`), completes it, closes the
   session and deletes the runner.

GitHub hands a runner any waiting job with its label, oldest first, not
necessarily the one that woke the answerer. A job it was offered instead is
answered all the same, and the answerer starts again for the original, at most
four runners in all. A job that asked for the relay label but names no relay
input, and is not made only of check steps, fails with a sentence saying a
relay never runs a job's steps.

## Rescue and sweep

`rescue(connections)` reads each connected repository's queued and in-progress
runs and their jobs, as the job poller does, and answers every queued relay
job it finds. A relay job whose `queued` webhook never arrived is answered on
the next poll. `sweep(connections)` deletes `hobo-relay-*` runners, on the
repository or its organization, whose run has ended.

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

## Tests

`test/relay-answer.test.ts` runs the T2 cases against the simulator: R01 (an
answer within five seconds of the webhook, on no runner), R04 (nothing fits:
the relay job fails with the reason and the job behind it is skipped), R05
(a busy machine is waited on and cancelling frees the job), R06b (the fleet
takes a public repository's job only when it isolates), R13 (a lost webhook
is rescued), R16 (with the first node down, the second answers exactly once)
and X01. `test/relay-answer-facts.test.ts` covers the facts and the file.

The run that would prove relay mode: turn `relayJobs.answer` on for one
repository on a deployed relay, push a workflow whose relay job asks for
`hobo-relay`, and link the run showing the relay job completed with no billed
minute and the job behind it on the runner the relay named.
