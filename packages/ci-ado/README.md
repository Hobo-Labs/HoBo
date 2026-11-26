# HoBo CI Azure DevOps

`@hobo/ci-ado` runs HoBo's portable command checks locally and generates Azure
DevOps Services YAML for Microsoft's official self-hosted Linux agent. Both jobs
select your named pool. Azure still manages checkout, logs, status and Pipeline
Artifacts; checks and artifact verification execute on your machine.

## Local checks and configuration

From the HoBo monorepo root, with Node 24, pnpm, Bash and your check tools installed:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm exec turbo run build --filter=@hobo/ci-ado --concurrency=100%
node packages/ci-ado/dist/cli.js run packages/ci-ado/examples/ci.json .
```

Local preflight needs no Azure account, agent or token. The commands themselves
and initial dependency installation may need network access. It creates no ADO
run, status or upload.

```json
{
  "schemaVersion": "hobo.ci.ado/v1",
  "pool": "hobo-local",
  "demands": ["Agent.OS -equals Linux"],
  "pipelinePath": "packages/ci-ado/examples/pipeline.json",
  "artifactPrefix": "hobo",
  "environmentRefs": {},
  "verifyArtifacts": true
}
```

Point `pipelinePath` at your portable `@hobo/ci` Pipeline JSON. Steps contain
literal `argv`, optional workspace-relative `cwd`, and explicit `env` values.
They execute sequentially and stop at the first nonzero exit. Artifact paths
name regular files inside the workspace; directories and globs are unsupported.
The runtime bounds output streams and individual artifact files to 1 MiB,
enforces the command deadline, and confirms process-group shutdown on timeout
or repeated cancellation signals. Each direct invocation gets a fresh execution
ID; direct CLI execution has no durable budget or replay journal.

To persist the collected result, pass `--artifacts /existing-parent/fresh-name`.
The leaf directory must not exist. Successful bundles contain `result.json`
(metadata and SHA-256 hashes) and `artifacts/<declared-path>`. Files are copied
from the bytes already collected by the runtime, so later source-file changes
do not change the published snapshot. Failed or timed-out checks exit nonzero
and retain a failure report without partial artifact bytes. Cancellation can
prevent ADO publication; no upload is promised after cancellation.

### Environment references

Keep credentials out of committed plan JSON. `environmentRefs` maps a check
variable to an explicitly authorized host/ADO variable:

```json
{ "environmentRefs": { "API_TOKEN": "CHECK_API_TOKEN" } }
```

Set `CHECK_API_TOKEN` locally, or define it as a secret pipeline variable in ADO.
The generated YAML maps it only onto the check task. Missing, empty or unresolved
bindings fail before commands execute. A binding cannot override a step literal
or HoBo's reserved `HOBO_CI_` metadata. Arbitrary ambient host variables and ADO
tokens are not inherited by check processes; required secrets must be declared.
Complete bound values are masked in captured stdout/stderr. This is exact-value
masking: transformed values and artifact contents remain the command author's
responsibility. Use trusted code and a dedicated self-hosted agent account.

### Consumer repositories

This is currently a private workspace package, like the other HoBo CI adapters;
it is not published to the public npm registry. The default bootstrap uses a
frozen monorepo install and a scoped `@hobo/ci-ado` build. A repository that
already vendors or distributes the package can override both literal argv lists:

```json
{
  "runnerArgv": ["node", "tools/hobo-ci-ado/dist/cli.js"],
  "bootstrapArgv": ["pnpm", "run", "prepare-hobo-ci"]
}
```

Empty lists retain the monorepo defaults. Azure expression tokens are rejected
in these lists. Bootstrap executes repository code and must install/build the
chosen runner. Its required package-registry authentication belongs in the
operator's agent setup; check secret bindings are not passed to bootstrap.

## Run the ADO pipeline on your machine

1. Create a dedicated self-hosted pool named `hobo-local`, or change `pool`.
   Register Microsoft's Linux agent, keep it online and authorize the pipeline
   to use the pool. Agent installation and repository connection setup are
   operator prerequisites. The YAML cleans each agent workspace.
2. Generate and commit the YAML beside the config and command plan:

   ```sh
   node packages/ci-ado/dist/cli.js yaml packages/ci-ado/examples/ci.json . > azure-pipelines.yml
   node packages/ci-ado/dist/cli.js yaml packages/ci-ado/examples/ci.json . --check azure-pipelines.yml
   ```

3. Create an ADO pipeline pointing to the YAML and queue it manually. Configure
   triggers or Azure Repos branch build-validation policies explicitly. Generated
   YAML disables automatic triggers. An offline agent leaves the job queued in
   its selected pool; there is no Microsoft-hosted fallback.

Generated scripts carry a canonical config/plan digest. Changes to commands,
timeouts, bindings or artifact declarations require regeneration; stale intent
fails before check execution. `yaml --check` detects rendering drift, including
changes to the generator. Producer timeout includes ten minutes beyond the
command deadline for setup/publication; the verifier has ten minutes for its
own setup/download. An agent must have the prerequisite tools and adequate disk.

The producer stages a fresh bundle under `Agent.TempDirectory` and publishes it
with `PublishPipelineArtifact@1`. Names include `System.JobId` and
`System.JobAttempt`, so job retries do not collide with immutable earlier
artifacts. Failure reports can publish while the producer remains failed.

By default a second job in the same self-hosted pool uses
`DownloadPipelineArtifact@2` for the current run. Native output variables carry
the producer's artifact name and manifest SHA-256 into the consumer. The CLI
verifies that digest, the config/plan identity, the exact declared file set,
sizes and each file's SHA-256. The pipeline succeeds only after verification.
`verifyArtifacts: false` explicitly removes this second job. Hashes protect
transport consistency; they are not signed attestations against a compromised
agent or malicious check process. Pipeline retention controls bundle lifetime.

For a downloaded bundle, the equivalent local command is:

```sh
node packages/ci-ado/dist/cli.js verify /path/to/bundle --config packages/ci-ado/examples/ci.json --expected-plan PLAN_SHA256 --expected-bundle PRODUCER_MANIFEST_SHA256
```

Both digests are printed by execution or present in the generated/native output.
Without `--expected-bundle`, standalone verification checks manifest/file
consistency and plan identity without the producer's manifest anchor.

## Live acceptance command

The package can queue and observe one existing pipeline at an exact committed
source version. Create a local target file containing references, never a token:

```json
{
  "organizationUrl": "https://dev.azure.com/your-organization",
  "project": "your-project",
  "pipelineId": 7,
  "refName": "refs/heads/main",
  "sourceVersion": "0000000000000000000000000000000000000000",
  "tokenEnv": "HOBO_ADO_PAT",
  "authentication": "pat",
  "timeoutSeconds": 1800
}
```

Replace the zero SHA with the commit containing your generated YAML/config/plan
and set `HOBO_ADO_PAT` through your secret environment. PAT authorization needs
Build Read & execute and Agent Pools Read plus access to the configured project,
pipeline and pool. `authentication: "bearer"` supports an already authorized
bearer token through the same environment reference.

```sh
node packages/ci-ado/dist/cli.js live packages/ci-ado/examples/ci.json live-target.json .
```

The command confirms the pool is self-hosted, pins the pipeline revision,
previews the exact source commit, and refuses hosted/extra jobs or a missing
plan guard/native verification. It then queues one run and checks source/pool
provenance, successful producer/consumer jobs and native upload/download/hash
tasks, and a retained Pipeline Artifact. The JSON result includes the run URL.
Timeout or interruption cancels a known unfinished run and waits for terminal
state. Ambiguous run creation is never automatically retried; inspect ADO's run
list before retrying manually. This command requires `verifyArtifacts: true`.
It does not create pipelines, install agents or infer billing entitlements.

## Scheduler integration

`createAdoBackend({ workspace })` can be bound to `PipelineScheduler` as backend
`ado`. Configure its authorized offer with `provider: "azure-devops"` and
`backend: "ado"`; desired policies also accept `kind: "azure-devops"`. Bindings
execute the host workspace directly, without queueing a remote ADO pipeline.
The shared SQLite actor owns `ci.*` commands/events, leases, snapshots and replay.
A recovered completed execution returns its recorded result without rerunning
commands. Set prices and entitlements from account-authorized observations;
self-hosted execution does not invent a free-minute balance. Keep secrets out
of durable generic Pipeline records; the direct CLI environment-reference path
resolves secrets only in memory.

## Costs, scope and verification evidence

Vendor documentation checked 2026-10-29:

- [Self-hosted parallel jobs](https://learn.microsoft.com/en-us/azure/devops/pipelines/licensing/concurrent-jobs?view=azure-devops): private projects include one self-hosted parallel job with unlimited minutes, plus eligible Visual Studio Enterprise entitlements. Extra concurrency can require paid capacity. Verify your organization's entitlement.
- [Pipeline Artifacts](https://learn.microsoft.com/en-us/azure/devops/pipelines/artifacts/pipeline-artifacts?view=azure-devops): Pipeline Artifacts and Pipeline Caching are exempt from storage billing. Azure Artifacts package feeds are a separate service.
- [Linux agents](https://learn.microsoft.com/en-us/azure/devops/pipelines/agents/linux-agent?view=azure-devops): real Azure Pipelines execution uses Microsoft's official agent.

Your machine avoids Microsoft-hosted compute minutes. Hardware, electricity,
network and extra concurrency remain possible costs. Local preflight consumes
no ADO parallel slot. Real ADO runs require Azure connectivity.

Supported scope is Linux self-hosted Azure DevOps Services and portable command
plans. Arbitrary Azure templates, tasks, variable groups, service connections,
matrices, approvals and deployments still require the official agent; this CLI
does not emulate Azure YAML offline. Azure DevOps Server's Build Artifacts tasks
are outside this Services adapter.

Protobuf/CUE contracts, valid/invalid fixtures, real subprocess tests and
deterministic YAML fixtures cover local boundaries. PACT brokers external
connections for the default acceptance lane through `@hobo/contract-harness`.
The complete REST Pact declares pool discovery, revision lookup, compiled/shortcut
previews, pinned queueing, polling, timeline, artifacts, cancellation, redirects
and authorization failures. Tests exercise the shipped client through both an
injected transport and a real loopback HTTP broker. Requests must match the
recorded headers, exact query/revision, commit and body; unmatched or unconsumed
interactions fail independently of the client's error handling.

The generated two-job acceptance test executes actual Bash/CLI scripts. Its
filesystem task host checks native publication and download inputs against the
Pipeline Artifact Pact before transferring collected bytes. Local end-to-end
contract acceptance needs no Azure organization, agent or credentials. These
hand-authored consumer expectations do not constitute remote Azure provider
verification or published Pact Broker results. The authenticated `live` command
remains a separate check of actual agent assignment and service behavior.

The [edge-case matrix](test/edges/README.md) maps admission, failure, cancellation,
transport, filesystem, configuration and CLI boundaries to executable tests.
Cancellation confirms the exact run identity, and body/header waits are bounded
even when a custom transport ignores abort. Download verification rejects extra
entries and symlinks as well as incorrect hashes. Git refs and prototype-map keys
are rejected before they can produce different execution intent.

```sh
corepack pnpm --filter @hobo/ci-ado build
corepack pnpm --filter @hobo/ci-ado typecheck
corepack pnpm --filter @hobo/ci-ado test
corepack pnpm --filter @hobo/ci-ado test:contracts
corepack pnpm --filter @hobo/ci-ado test:coverage
corepack pnpm codegen:check --filter packages/ci-ado
```
