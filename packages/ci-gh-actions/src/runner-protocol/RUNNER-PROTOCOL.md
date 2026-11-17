# Runner protocol client

In relay mode (ADR-0183, [`docs/design/adr/runner-order.md`](../../../../docs/design/adr/runner-order.md))
a HoBo node answers a relay job itself: it signs in to GitHub's runner service
as a one-job runner labelled `hobo-relay`, takes the job, decides with
`answerRelayJob` from `@hobo/ci` (see [`packages/ci/RELAY-JOB.md`](../../../ci/RELAY-JOB.md)),
and completes the job with outputs. No runner program starts, so the job uses
no runner minute and no job code runs.

This folder holds that client. **It is built, not proven.** It was written
from the open-source runner and tested against a fake of the service; no run
against GitHub's runner service is linked yet. It ships off: `open` refuses
unless `relayJobs.answer` is on in `.hobo/ci.json`, and that is off unless a
repository turns it on.

## Files

| File | What it holds |
| --- | --- |
| [`port.ts`](port.ts) | The port: `RunnerServiceClient`, `RunnerSession`, `ParsedJitConfig`, an in-memory service and the conformance test every client passes |
| [`jit-config.ts`](jit-config.ts) | `parseJitConfig`: decodes an `encoded_jit_config` and refuses it unless every URL is https on a GitHub host, no two keys differ only by case, the RSA key is usable and the runner is the one expected |
| [`client.ts`](client.ts) | `GithubRunnerServiceClient`: the protocol itself |
| [`wire.ts`](wire.ts) | The protocol's messages, and the mapping from a job message to a `RelayJobMessage` and from a `RelayJobAnswer` to a completion |
| [`json.ts`](json.ts) | Reads JSON the way the runner does: keys without regard to case, and two keys that differ only by case refused |
| [`fake-service.ts`](fake-service.ts) | `FakeGithubRunnerService`: the service in memory, for tests and for the GitHub simulator to mount through its `handle(request)` |
| [`source.ts`](source.ts) | The `actions/runner` commit everything was read from, and the runner version the client reports |

## Where the protocol comes from

Every path and field was read from `actions/runner` (MIT) at commit
`af09a511a0869abf002daef236c66c5b146d683a` on 2026-11-17, and from nothing
else. Each field in the code names the file it came from, and so does each
interaction in
[`contracts/github-runner-service.pact.json`](../../contracts/github-runner-service.pact.json).
That pact is hand-authored consumer expectations, not captured traffic;
`test/runner-protocol-pact.test.ts` executes every interaction in order.

| Step | Call | Read from (under `src/`) |
| --- | --- | --- |
| Sign in | `POST` the credentials' `authorizationUrl` with a client assertion signed RS256 by the runner's key (issuer and subject the client id, audience the token URL, five minutes) | `Runner.Listener/Configuration/OAuthCredential.cs`, `Sdk/WebApi/WebApi/OAuth/VssOAuthJwtBearerAssertion.cs` |
| Open | `POST {ServerUrlV2}session` | `Sdk/WebApi/WebApi/BrokerHttpClient.cs` |
| Wait | `GET {ServerUrlV2}message` (long poll) | `BrokerHttpClient.cs`, `Runner.Listener/BrokerMessageListener.cs` |
| Acknowledge | `POST {ServerUrlV2}acknowledge`, when the offer says `should_acknowledge` | `BrokerHttpClient.cs`, `Runner.Listener/Runner.cs` |
| Take | `POST {run_service_url}acquirejob` | `Sdk/RSWebApi/RunServiceHttpClient.cs` |
| Complete | `POST {run_service_url}completejob` with the conclusion, outputs and annotations | `RunServiceHttpClient.cs`, `Sdk/RSWebApi/Contracts/CompleteJobRequest.cs` |
| Close | `DELETE {ServerUrlV2}session` | `BrokerHttpClient.cs` |

Acknowledging is the one call beyond open, take, complete and close: the
runner makes it when an offer asks, so the client does too. The client does
not renew the job's lock (`renewjob`), since a relay answers in seconds. It
speaks only the broker flow (`UseV2Flow` and `ServerUrlV2` in `.runner`); a
configuration without it is refused at `open`.

## How a job becomes a relay job message

The run's facts come from the job's `github` context: `repository`, `run_id`,
`run_attempt`, `job`, `event_name`, `actor_id` and `workflow_ref`, and from the
event payload `repository.private`, `sender.id` and the pull request's head
repository (a fork when it says so or names another repository). A payload
that does not say whether the repository is private is read as public, which
machines refuse. The relay's inputs come from the `inputs` context a called
workflow's job is given; names that are not relay inputs are left out. Each
step becomes its `uses:` and `with:`.

A job is a relay job when it names at least one relay input, or when every
step is a HoBo check step. Anything else asked for the relay label by
mistake. The client completes it as failed, with an annotation saying so,
and keeps waiting: a relay runs no job code, so it could never run it.

## Behaviour

- Every call has a deadline (60 seconds unless set). A long poll waits as long
  as the caller asked, and at least one second.
- A server error or a dropped connection is retried once. A 401 makes the
  client sign in again once. A `ForceTokenRefresh` message drops the token.
- An offer another runner acquired first (404, 409 or 422 on `acquirejob`) is
  skipped, as the runner skips it.
- A message type the client does not know is ignored, and reported through
  `onEvent`.
- A call goes only to an https GitHub host, with redirects refused, so the
  runner's token never leaves GitHub. The run service URL in an offer is
  checked the same way before it is called.
- Events (`onEvent`) carry no token or key, and neither does any error.

## What it can never do

The folder imports only `@bufbuild/protobuf`, `@hobo/ci`, `zod`,
`node:buffer` and `node:crypto`. It starts no process and runs no job code.
`test/runner-protocol-safety.test.ts` reads every source in the folder and
fails on any other import or on anything that could run a program (gauntlet
case X03).

## Proving it

The channel stays "built, not proven" until one live run is linked: a relay
with `relayJobs.answer` on creates a one-job runner with the `hobo-relay`
label on a test repository, a workflow queues a relay job, the client answers
it, and the run shows the job completed with its `runner` output and no billed
minutes (gauntlet case R01 at T3). Two things only that run can show: whether
the broker hands a message to a long poll that the client ended early, and
whether the run service needs anything beyond `completejob` (such as a
timeline update) for the job page to read well.
