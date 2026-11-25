# HoBo CI Dagger

`@hobo/ci-dagger` runs native Dagger CI checks on local or self-hosted engines.
It also executes the same parsed `@hobo/ci` command pipeline used by the
GitHub Actions and Cloudflare CI adapters. `createDaggerBackend` binds the source
workspace and a digest-pinned toolchain image to a Dagger SDK connection. The
pinned upstream SDK is `@dagger.io/dagger` 0.21.11.

## Native Dagger CI checks without Cloud execution

The new Dagger 1.0 beta uses `dagger.toml`, `dagger.lock`, and `dagger check`.
Checks can run on a laptop with a Linux container runtime or on an engine your
team operates, without a Dagger Cloud account. HoBo uses the installed native
CLI for this surface; the older SDK adapter below remains a separate API.

Initialize/install your Dagger modules using the upstream CLI, then commit
`dagger.toml`, `dagger.lock`, and local module sources. Create `.hobo/dagger.json`
in the consuming repository from [`examples/local-checks.json`](examples/local-checks.json):

```json
{
  "engine": "local",
  "cliVersion": "1.0.0-beta.21",
  "workspace": ".",
  "filters": [],
  "skip": [],
  "parallel": 4,
  "failFast": false,
  "timeoutSeconds": 900,
  "environment": ""
}
```

Set `cliVersion` to the exact installed 1.x version from `dagger version`.
Version 1.0.0-beta.21 is exercised by this package's live Linux acceptance lane.
Install it using the [upstream installation guide](https://docs.dagger.io/getting-started/install/).
HoBo checks the version before
starting checks and never downloads or upgrades a CLI. Build the package once,
then run from the repository containing `.hobo/dagger.json`:

```sh
pnpm --filter @hobo/ci-dagger build
pnpm --filter @hobo/ci-dagger checks --plan
pnpm --filter @hobo/ci-dagger checks
```

`--config path/to/config.json` selects another file; `--dagger /path/to/dagger`
selects a host-installed executable. `--plan` prints the exact
executable and argv without requiring Dagger, Docker, an account, or network
access. The invocation directory (`INIT_CWD` under pnpm) is the repository root;
`workspace` is relative to that root, independently of the config file location.

`engine: "local"` becomes an explicit
`--engine=image://registry.dagger.io/engine:v<cliVersion>`. Dagger starts/reuses
that engine through the local container runtime and retains its local cache.
There is no upstream engine value named `local`; HoBo translates it. The CLI
streams check logs and preserves its exit code, including failed checks.
`filters` selects check links, `skip` excludes links, `parallel: 0` removes the
parallelism limit, and `failFast` cancels remaining checks on first failure.
`timeoutSeconds` sets an overall wall-clock deadline including startup (default
900 seconds, at most 86400; zero selects the default). A timeout exits with code
124. `environment: "ci"` selects the matching `[env.ci]` overlay in `dagger.toml`;
omit it or use an empty string for the workspace's default environment. Execution
fails before starting the CLI when the selected workspace lacks `dagger.toml`.

To use infrastructure you operate, change `engine` to an explicit URI, for example
`unix:///run/dagger/engine.sock`, `kube-pod://checks-0?namespace=dagger`, or
`tcp://engine.internal:1234`. `tls://`, `ssh://`, `container://`, and `image://`
are also accepted. Keep the CLI and engine versions matched. Use private
networking for unauthenticated TCP engines or an authenticated transport. Persistent
engine disks preserve cache; ephemeral engines lose it between jobs.
Explicit container runtime transports such as `image+podman://IMAGE`,
`container+docker://NAME`, `image+apple://IMAGE`, `image+finch://IMAGE`, and
`image+nerdctl://IMAGE` are forwarded to Dagger as well.

The native runner rejects Cloud selectors, removes inherited Cloud tokens,
engine selectors and nested session credentials **in the child process**, and
uses temporary empty user settings so a saved Dagger Cloud login cannot send
Cloud traces. It preserves proxy, CA trust and container runtime environment
settings. The parent environment, login, and user configuration stay intact.
Per-user Dagger module settings are intentionally excluded; put required settings
in the repository's `dagger.toml`. The selected engine and third-party modules
remain operator-controlled: their infrastructure and any APIs they call can
have their own costs. This runner does not enable Cloud Checks or publish results
to GitHub; HoBo or another CI trigger must invoke it.

If **Cloud Checks were already enabled** for the workspace, local configuration
does not turn off their separate push/PR runs. Disable them once with
`dagger cloud checks off` in that workspace to stop that source of Cloud usage.

The same config is available programmatically:

```ts
import { readFile } from 'node:fs/promises';
import { parseDaggerCheckConfig, runDaggerChecks } from '@hobo/ci-dagger/checks';

const config = parseDaggerCheckConfig(await readFile('.hobo/dagger.json', 'utf8'));
process.exitCode = await runDaggerChecks(config);
```

`runDaggerChecks` accepts a host-selected executable, environment, working
directory, and abort signal. Aborting sends SIGTERM, escalates to SIGKILL after
five seconds, and awaits CLI exit. On POSIX, transport subprocesses in the owned
process group are terminated too, and background transports are cleaned up after
successful completion as well. The CLI preserves conventional SIGINT/SIGTERM
exit codes 130/143. The programmatic API rejects with `DaggerCheckTimeoutError`
on a deadline, and propagates caller abort reasons. Neither is an acknowledgment
that a remote engine terminated every operation. This direct check runner does
not participate in HoBo's budget lease/scheduler lifecycle.

Upstream references checked 2026-10-29:
[self-hosting](https://docs.dagger.io/self-hosting/),
[CLI/check options](https://docs.dagger.io/reference/cli/#dagger-check),
[`dagger.toml`](https://docs.dagger.io/reference/config-files/dagger-toml/),
[Cloud authentication](https://github.com/dagger/dagger/blob/main/internal/cloud/auth/auth.go).

## Portable SDK command pipelines

```ts
import { executePipeline, parsePipeline } from '@hobo/ci';
import { createDaggerBackend } from '@hobo/ci-dagger';

const image = process.env.CI_TOOLCHAIN_IMAGE;
if (!image) throw new Error('Set the reviewed toolchain image@sha256:…');
const backend = createDaggerBackend({sourceDirectory: process.cwd(), image});
const pipeline = parsePipeline(JSON.stringify({
  id: crypto.randomUUID(), accountId: 'my-account', timeoutSeconds: 300,
  steps: [{id: 'test', argv: ['npm', 'test'], cwd: '.', env: {}}],
  artifactPaths: [],
}));
const result = await executePipeline(backend, pipeline);
```

The source workspace is copied through Dagger Directory snapshots between steps.
Each step begins with the clean image environment, so a step's environment values
do not leak into later steps. `HOBO_CI_EXECUTION_ID` is a reserved environment
variable set to `pipeline.id` after user env. Dagger's command cache is therefore
scoped to the logical execution: a new run must use a new pipeline ID (include the
run/revision in the caller's identity), while replaying that same ID can reuse its
DAG. The scheduler separately deduplicates a completed logical execution. Commands use argv arrays with `ReturnType.Any` to
retain nonzero exit codes and logs. GNU `timeout` bounds each command; the overall
pipeline deadline is enforced by the shared executor. The image must provide GNU
`timeout`, `base64`, `realpath`, and a POSIX shell. Container nesting or privileged
host execution is never enabled.

Declared file artifacts are size-checked remotely before base64 encoding, after
resolving their paths inside `/workspace`; binary bytes and SHA-256 digests use the common artifact contract.
The adapter rejects files above one MiB before they enter SDK stdout; the shared
executor independently checks artifact integrity and the same file limit.
Repeated session close calls share the same shutdown acknowledgment, including a
pending or rejected acknowledgment.

An injected `DaggerConnector` can bind a customer-owned managed engine and its
shutdown acknowledgment. The default uses the actual SDK `connect` lifecycle,
which provisions/closes its engine session. The SDK offers no public per-command
stop acknowledgment. If a request is still running at cancellation and the
connection cannot acknowledge a provider `stop()`, cleanup rejects and the shared
executor reports `uncertain`; it does not claim confirmed cancellation or replay
the command on another provider. Completed commands close normally. A first failed SDK log/read query does not clear
in-flight state while sibling queries still evaluate the graph. A failed exit-code
query also retains uncertainty until the provider positively acknowledges stop.

`getReadiness()` and `parseReadiness()` expose an immutable, generated implemented
SDK-readiness record. This is implementation metadata, not budget authorization
or a claim that an engine/provider is currently connected. HoBo's scheduler must
reserve the selected account's allocation before execution.

Validation is local and contract-based: SDK fluent-port requests, snapshot chaining,
command outputs, failures, binary artifacts, cancellation acknowledgment and
unconfirmed shutdown are exercised by `test/backend.test.ts` and the hand-authored
`contracts/execution.pact.json`. A compile-time witness ensures the real SDK client
implements the injected port. `contracts/sdk-graphql.consumer.test.ts` also drives
the default connector through the actual SDK against a strict local GraphQL server,
including authentication, source Directory IDs, command queries and results. No provider resource or remote account is created by
these tests. A reusable `test/fixtures/local-engine.ts` contract fixture also runs
real POSIX commands and files for the cross-backend conformance suite; it is not a
Dagger engine or a security sandbox. Run package `build`, `typecheck`, `test`, `lint`, plus scoped codegen.

Native checks use generated `CheckConfig` protobuf types and `ci_dagger.cue`
constraints with valid/invalid fixtures. `contracts/checks-cli.pact.json` and
`test/checks.test.ts` verify real subprocess argv, version pins, Cloud/session
isolation, preserved toolchain settings, exit status, and side-effect-free plans.
These consumer-contract tests run without a live Dagger engine.

The process-group tests wait on events, never on the clock. The fixture CLI or
its transport child connects to a Unix socket the test owns (`FIXTURE_PROBE`)
once it is ready, and the kernel closes that connection when the process dies.
That gives the test both "ready to abort" and "really stopped" without polling
files or `/proc`. Their timeout is only a hang guard: a stalled host makes them
slower, never red.

The separate [live acceptance lane](acceptance/README.md) runs the **compiled**
CLI against a real Dagger engine and digest-pinned container commands. It verifies
passing/failing checks, exclusions, unmatched filters, named overlays, uncommitted
workspace changes, deadlines, SIGINT/SIGTERM and isolation from saved/inherited
Cloud and session credentials. It is a manual operator-owned-infrastructure lane;
the default unit/contract tests remain offline. Run it with `pnpm --filter
@hobo/ci-dagger test:acceptance --dagger /path/to/dagger`.
