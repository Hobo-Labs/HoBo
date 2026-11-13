# The `github-actions-job` work kind (L16)

HoBo Fleet's work kind for GitHub Actions jobs (ADR-0182; fleet design §6.9 table and step 7, §6.11). `@hobo/fleet/work` does not know what a job is: this directory supplies its two halves.

| Entry point | Half | What it does |
|---|---|---|
| `createGithubActionsWorkSource(options)` | Dispatcher | Reads GitHub's queue with the existing poller (`isolated-worker/github-job-poller.ts`, imported unchanged) and turns each queued, unassigned job whose label HoBo serves into upstream work; `prepare` mints one just-in-time runner registration for the claimant, which is the order's sealed secret |
| `createGithubActionsWorkRunner()` | Executor | In the order's sandbox: writes the registration with `Sandbox.writeSecret`, installs the pre-job hook, runs one runner for one job, and reports the receipt status |

## The work source

- **The poller is the existing one.** Its options are passed through unchanged; only its `ingest` is wrapped so the source sees each delivery before the poller's own intake does (and the intake still receives every delivery). A job seen queued and unassigned becomes upstream work; a job the poll lists as waiting (coalesced or deferred) stays; anything else is dropped at the next poll. A poll cut short by GitHub's rate limit changes nothing.
- **Facts.** `workKey` is `<owner/name>#<job id>@<run attempt>`. From the run (`GET /repos/{repo}/actions/runs/{id}`, cached per attempt): `author` is `github:<id>` of the triggering actor (the actor when GitHub names none); `origin` is `INTERNAL` for `push`, `schedule`, `workflow_dispatch`, `merge_group`, `repository_dispatch` and `release`, for pull-request events `INTERNAL` when the head repository is the repository itself, `FORK` when it is another and `UNKNOWN` when GitHub names none, and `UNKNOWN` for every other event (`origin.ts`); `ref` is `refs/pull/<n>/merge` for a pull-request event that names its pull request (not `pull_request_target`), else `refs/heads/<head branch>`; `workflowDigest` is `sha256:<hex>` of the workflow file at the run's commit (`GET /contents/{path}?ref={sha}`), empty when GitHub will not give it. A run GitHub will not describe is not offered that poll.
- **Size.** Memory from the worker's memory classes at their defaults (`memoryRequestForJob`), disk from the storage class's work-root reserve, the served label as the one label, platform `linux`.
- **Fleet policy.** Only repositories the fleet's `RepositoryRule`s name, and, when the policy lists `labels`, only those labels.
- **`prepare`** mints with the labels `jitRunnerRegistrationLabels` gives (a trunk runner never joins the shared label) and a runner name `hobo-fleet-<member>-<digest prefix>` (at most 64 characters). Its parameters are `image` (`ghcr.io/actions/actions-runner:<RUNNER_VERSION>`), `runnerName` and `label`; nothing secret. `egressAllow` is GitHub's documented runner hosts, exact names only. Prepared work is not offered again for ten minutes while GitHub still lists it queued. A failed registration is passed on.
- **`stillWanted`** asks GitHub for the job: wanted while it is queued and unassigned; a GitHub error counts as wanted (an idle registration is the worst case, §6.9 "Dispatcher duplicates").

## The runner and the start fence

1. `writeSecret("/run/hobo-fleet/registration", registration)`; never argv or environment.
2. The pre-job hook (`hook.ts`) is written to `/work/hobo-fleet/pre-job.sh` over standard input. It carries the sandbox's own `controlUrl`.
3. The start script copies the runner out of the image's read-only root into `/work/runner`, reads the registration into the runner's environment and deletes the file, sets `ACTIONS_RUNNER_HOOK_JOB_STARTED` and `RUNNER_ALLOW_RUNASROOT`, and runs `run.sh` for its one job.
4. Before the job's first step GitHub's runner runs the hook. It reads GitHub's own job context (`GITHUB_REPOSITORY`, `GITHUB_REF`, `GITHUB_ACTOR_ID`, `GITHUB_EVENT_NAME`, the head repository from `GITHUB_EVENT_PATH`, the run and job) and posts an `ObservedAssignment` to `<controlUrl>/fence` with `wget` or `curl`. The device answers with `checkAssignment`. Anything but `{"allow":true}` fails the hook, which fails the job before any step runs. The hook applies `origin.ts`'s rules in POSIX shell without a JSON parser: the head repository is the first `full_name` inside `"repo"` of `"head"`, read only up to `"base"`; escaped text inside a JSON string can never match those key patterns, and anything it cannot read for certain is `WORK_ORIGIN_UNKNOWN` (`UNTRUSTED`).
5. After the runner exits, the start script prints the hook's verdict, the facts it posted and the exit code as `@@hobo-fleet` lines. Receipt: `REFUSED` with `assignment-mismatch` when the fence refused; otherwise the runner's own `Job … completed with result:` line (`SUCCEEDED`, `FAILED`, `CANCELLED`); `ABANDONED` (`unavailable`) when no job ran; `CANCELLED` when the order was aborted. `observedWorkKey` is the job the hook saw (`<repo>/runs/<id>/attempts/<n>/jobs/<job>`), since GitHub may assign the runner another job of the same label (§6.9 step 7). The output digest is `sha256:` of the runner's console.

The hook's verdict file sits in the job's writable directory, so a job the fence allowed could rewrite it; that only changes how its own receipt is labelled, never whether it was allowed to start.

## Tests

- `test/fleet-work/source.test.ts`, `runner.test.ts`: the two halves against a fake GitHub transport and a GitHub-runner double over `createFakeSandboxDriver`.
- `test/fleet-work/job.test.ts` (the isolated check): one job from offer to `SUCCEEDED` receipt on the in-memory bus, and a fork job stopped by the fence from the facts the hook posts.
- `test/fleet-job.integration.test.ts` (O24): the same over a real `nats-server` with the auth callout; skips outside CI when `nats-server` is absent, fails in CI.
- `test/fleet-fence.integration.test.ts` (O24): a real `S1` sandbox from `sandboxDrivers()`, the real hook written as the runner writes it and run as GitHub runs it against `controlUrl`; a fork context is refused before the steps start, an internal one is allowed; the hook's head-repository reading fails closed. Fails when no `S1` driver passes its self-test. Verified on the provisioned runsc in rootful mode.
