# GitHub simulator

An in-memory GitHub that the relay tests and the HoBo CI parity scenarios run against. It needs no network and no GitHub account. It implements the simulator interface in [`../github-simulator-port.ts`](../github-simulator-port.ts) and is part of the relay-job work recorded in [ADR-0183](../../../../../docs/ci/runner-order.md).

```ts
import { GithubSimulator, SimulatedRunnerService } from "./support/github-simulator/index.js";

const github = new GithubSimulator();
const relay = github.queueJob({ repository: "octo/app", name: "route", labels: ["hobo-relay"] });
github.queueJob({
	repository: "octo/app",
	name: "build",
	runId: relay.runId,
	labels: ["${{ needs.route.outputs.runner }}"],
	needs: ["route"],
});
await github.deliver(relayWebhookHandler); // the signed workflow_job webhooks
```

## What it serves

All of it is reached through `github.fetch` under `github.baseUrl`. Every request is recorded in `github.requests()`, so a test can show that something was never asked for. A URL outside `baseUrl` fails like an unreachable host.

| Area | Routes |
| --- | --- |
| Runs | list (`status`, `event`, `per_page`, `page`), get, get an attempt, jobs (`filter=latest` or `all`), an attempt's jobs, `rerun`, `rerun-failed-jobs`, `cancel` |
| Jobs | get, `logs` (answers 302 to a download URL, as GitHub does; `fetch` follows it by default, returns it for `redirect: "manual"`, and rejects it for `redirect: "error"`), check-run annotations |
| Runners | for a repository or an organization: list (`name`), get, delete, `generate-jitconfig`, and labels (list, add, set, remove all custom, remove one) |
| Repository | the repository, its installation, file contents (`ref` as a branch or its head commit) |
| Git | `GET git/ref/...`, `GET git/commits/{sha}`, and the writes the routing slip uses: `POST git/trees`, `POST git/commits`, `POST git/refs`, `PATCH git/refs/...` |
| Billing | `GET /users/{user}/settings/billing/usage` and `/organizations/{org}/settings/billing/usage`, filtered by `year`, `month` and `day` |
| Runner service | whatever is mounted with `mountRunnerService` under `RUNNER_SERVICE_PATH`; 501 until something is |

`simulatorTransport(github)` wraps it as the relay's `GithubTransport`, so code that takes a transport runs against it unchanged.

## Webhooks

`workflow_job` (`queued`, `in_progress`, `completed`) and `workflow_run` (`completed`) are signed with `webhookSecret` the way GitHub signs them (`X-Hub-Signature-256`) and carry `X-GitHub-Event` and `X-GitHub-Delivery`. They wait until `deliver(handler)` posts them, oldest first. `dropNextWebhook()` loses the next one, and `redeliver(id)` sends one again with the same id and body. `deliveries()` lists every webhook, including the lost ones.

## Jobs and runners

GitHub's matching rule decides who gets a job: a queued job is offered only to an online, free runner that holds every label the job asks for (compared without case) and serves the job's repository. `claim(runner)` takes the oldest such job and `complete(job, result)` finishes it with a conclusion, outputs, annotations, a log and steps. A job with `needs` stays off GitHub's lists until the jobs it needs finish. It is then queued, with `${{ needs.<job>.outputs.<name> }}` in its `runs-on` replaced by that output, or skipped when a needed job did not succeed. This is how one relay output routes several jobs or a matrix.

`registerRunner` adds a runner as an administrator would. `generate-jitconfig` adds an ephemeral runner that stays offline until a session opens. Its `encoded_jit_config` uses the format the open-source runner (`actions/runner`) reads: base64 JSON of the `.runner`, `.credentials` and `.credentials_rsaparams` files. An ephemeral runner is removed after its one job.

`SimulatedRunnerService` is the runner service behind the `RunnerServiceClient` port: a session signs in as a registered runner, is offered the jobs the matching rule gives that runner, and completes them with a `RelayJobAnswer`. It passes the port's conformance function. `nextJob` does not wait, because the simulator's clock moves only when a test moves it.

## Clock

`advance(ms)` moves the clock forward, never back. GitHub cancels a job that has been queued for 24 hours, and so does the simulator.

## What it leaves out

These are simplifications. A test should not depend on them.

- A runner registered with neither a repository nor an organization serves every repository. Runner groups and their access rules are not modelled.
- In `runs-on`, only `${{ needs.<job>.outputs.<name> }}` is substituted.
- A skipped dependent sends only its `completed` webhook.
- A run attempt completes when the last job it lists completes, so a test queues every job of a run before it finishes any.
- Runner OS is always `linux`, and the RSA parameters in a JIT config are placeholders.

GitHub behaviour is taken from GitHub's REST and Actions documentation and the `actions/runner` source, read on 2026-11-17. The source files are named in `state.ts`, `rest.ts` and `jit-config.ts`.
