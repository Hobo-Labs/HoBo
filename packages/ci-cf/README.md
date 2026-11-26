# HoBo CI Cloudflare

`@hobo/ci-cf` implements the shared HoBo pipeline backend using
[`@cloudflare/ci` 0.2.0](https://github.com/cloudflare/ci). The same parsed pipeline
used by GitHub Actions or Dagger can execute against a bound Cloudflare CI context.
Source selection and account authorization belong to the caller's existing
`CIWorkflow` and HoBo reservation, rather than a second unauthenticated API.

## Run checks locally

Local mode runs the real pinned Cloudflare CI SDK, Worker/Workflow engine and
Sandbox containers on Linux (including WSL) with a local Unix Docker socket.
Git, Node 22+, pnpm, util-linux `flock` and Docker are required. No Cloudflare account, token,
Artifacts repository, deployed Worker or remote R2 bucket is needed.

Use the same pipeline JSON as other HoBo CI packages. From the HoBo checkout:

```sh
pnpm --filter @hobo/ci-cf local:run \
  --source /absolute/path/to/git-repo \
  --pipeline /absolute/path/to/checks.json --ref HEAD
```

[`examples/local/pipeline.json`](examples/local/pipeline.json) shows the format.
Put dependency installation and your checks in ordered steps. The default image
includes Node/npm; pass `--dockerfile /absolute/path/to/Dockerfile` to extend the
pinned Sandbox image with your project's toolchain **before preparation**.

`local:run` prepares committed source, starts its private local runtime, submits
one native Workflow, waits for its actual terminal result, verifies artifact
hashes, exports artifacts and stops its Worker/process group and all owned Docker
containers, including proxy containers. Exit codes are:

| Code | Meaning |
| --- | --- |
| 0 | Every check passed, native Workflow completed, artifacts verified/exported, shutdown confirmed |
| 1 | Checks failed; later steps were not admitted; shutdown confirmed |
| 124 | Pipeline deadline exceeded; shutdown confirmed |
| 130 | SIGINT/SIGTERM cancellation; shutdown confirmed |
| 2 | Uncertain result, interrupted admission, input/preparation error or unconfirmed cleanup |

The pipeline timeout begins at submission, includes Sandbox/snapshot overhead,
and is enforced by the host controller as well as the SDK. Initial image building
has a separate five-minute bound; local bundle generation is limited to two minutes; Worker startup is limited to three minutes.
`--json` prints the protobuf JSON run receipt. Without it, the command prints the
outcome, Workflow ID and receipt path. Logs and receipts stay under the printed
preparation directory; artifacts are under `artifacts-<workflow-id>/`.

For inspection or repeated runs of immutable inputs:

```sh
pnpm --filter @hobo/ci-cf local:prepare \
  --source /absolute/path/to/git-repo --pipeline /absolute/path/to/checks.json
pnpm --filter @hobo/ci-cf local:run --directory /absolute/path/to/preparation
```

Each preparation has independent persisted Workflows/R2 state and a private
access token. Input digests bind the source archive, pipeline, Dockerfile, config
and controller implementation. Preparation uses Wrangler's local `deploy --dry-run`
bundler (no deployment or cloud bindings), pins every emitted Worker asset by
digest, and runs it with `no_bundle: true`. Rebuilding shared packages cannot
hot-reload an in-flight Workflow. Mutating prepared inputs requires a new preparation.
`--work-root PATH` selects the scratch root; `--port PORT` selects an explicit
loopback port. An OS-backed lock prevents concurrent controllers from owning the same preparation;
crashes release the lock, but an unfinished admission still requires explicit recovery. A port
occupied by a different preparation cannot admit work.

If the controller is killed, reconcile its recorded Workflow with:

```sh
pnpm --filter @hobo/ci-cf local:run \
  --directory /absolute/path/to/preparation --resume WORKFLOW_ID
```

A finished receipt is revalidated and returned. An interrupted admission is
**uncertain**: recovery stops the verified old process group and owned containers
and exits 2 without replaying commands. Start a new run explicitly after assessing
side effects. A durable R2 admission marker inside each native step also refuses
automatic repetition of an interrupted callback if the dev runtime restarts.
This conservative behavior does not claim exactly-once external effects.

For manual debugging, `local:dev --directory PATH` starts Wrangler; a second
terminal can use `local:trigger --directory PATH`. Trigger means asynchronous
submission, and its exit code is never a CI verdict. Manual dev/trigger is not the
managed lifecycle used by `local:run`. Use Wrangler's local Workflow inspector
with the preparation's `--config PATH/wrangler.jsonc` and `--port PORT`.

Preparation reads the selected Git commit, including recursively pinned,
initialized submodules, without modifying the checkout. Uncommitted and untracked
files are excluded. Git LFS pointer files are refused: materialize and commit the
actual content first. Dependency installation belongs in the pipeline. Git
repository selectors inherited from hooks cannot redirect source selection.

The generated config uses `--local`, loopback and binding-backed local R2 backups
(`localBucket: true` even with FUSE). Source checkout uses an image-baked file
archive; no Artifacts operation or cloud fallback exists. The private health,
status/result and cancellation endpoints require the preparation token and reject
browser Origin requests. Triggering uses Wrangler's existing local Workflow API.
The Docker context must point to a local Unix socket; remote engines are refused.
Receipts pin that socket and daemon identity, so changing the default Docker
context cannot redirect recovery or make cleanup falsely succeed.

Local networking preserves Cloudflare's pinned native egress proxy and mandatory
TPROXY interception. A small compatibility image skips only the optional
established-socket DIVERT fast path when the kernel explicitly lacks the socket
matcher. All other iptables errors propagate; kernels without working TPROXY fail
closed. The locally built content-addressed proxy image stays in your daemon;
Wrangler's otherwise unconditional pull resolves only that image from local cache.
Platform proxy and TLS settings remain in effect.

This avoids Cloudflare runtime and R2 charges for these checks. Commands can still
call paid APIs or deploy resources, and image/package downloads use the network.
Local CPU, retained state/images and any Docker subscription remain your costs.
Run trusted repositories; receipts/artifacts/logs contain command output and
should follow your normal local retention policy. Remove an unused preparation
after stopping its runtime; use your usual Docker image cleanup separately.

The supported version set is `@cloudflare/ci` 0.2.0, Sandbox 0.12.1 and Wrangler
4.114.0; these APIs are not interchangeable with Sandbox 1.x. Configuration was
checked against current [CI source](https://github.com/cloudflare/ci/releases/tag/v0.2.0),
[Containers local development](https://developers.cloudflare.com/containers/guides/local-dev/)
and [Workflows local development](https://developers.cloudflare.com/workflows/build/local-development/).

Run `pnpm --filter @hobo/ci-cf test:proof` for the exhaustive finite-state safety
proof and `pnpm --filter @hobo/ci-cf test:acceptance` for real local Docker/Workers/
Workflows/Sandbox/R2 acceptance. The latter uses an offline dependency fixture and
a local bridge HTTP counter, retains receipts and native logs, and requires no paid
resources. See [acceptance evidence](acceptance/README.md) for the executed cases
and the precise scope of the formal claim. These checks do not assert deployed
Cloudflare-account behavior or prove the third-party runtime implementation.

## Use an existing cloud CI context

```ts
import { createCloudflareBackend } from "@hobo/ci-cf";
import { executePipeline, parsePipeline } from "@hobo/ci/execution";

const backend = createCloudflareBackend({
  context: ci, // CiContext supplied by the actual CIWorkflow
  terminate: async () => {
    const instance = await env.CI_WORKFLOW.get(workflowInstanceId);
    await instance.terminate();
  },
  // Supply verifyShutdown only when an owned controller can prove all work stopped.
});
const pipeline = parsePipeline(JSON.stringify({
  id: "checks", accountId: "my-account", timeoutSeconds: 600,
  steps: [{ id: "test", argv: ["npm", "test"], cwd: ".", env: {} }],
  artifactPaths: [], requiredCapabilities: [],
}));
const result = await executePipeline(backend, pipeline);
```

The native SDK runs inside Workers. Node callers can import this adapter because
its native SDK imports are type-only; production execution still requires a real
Worker-owned `CiContext`. TypeScript consumers use bundler module resolution
because the upstream SDK publishes Worker-oriented TypeScript source. [`examples/worker`](examples/worker) provides a compiled
`CIWorkflow` entrypoint, binding configuration and digest-pinned sandbox base image.
It is a source example and is never deployed by the test suite. The Workflow binding
supplies a termination request. Stopping an in-flight or unconfirmed native call is
only confirmed when an application-owned `verifyShutdown` callback positively acknowledges stopped
Workflow/sandbox work. A termination request alone, a false verifier or a failed
controller produces an `uncertain` result and retains the HoBo reservation. The
source example deliberately has no invented shutdown-verification service. A command
that has already exited (including a nonzero exit) returns its result without
self-terminating the Workflow; the example can then report an ordinary build failure.

Each pipeline step calls the previous result's `runner`, preserving the native
snapshot chain. The first step alone calls the root `ci.runner`. Because the SDK
overlays original tracked source after restoring each snapshot, HoBo initializes
a private copy under `.hobo-ci-workspaces/<pipeline.id>` and runs user commands
there. Native checkout overlays affect only the outer source; tracked edits and
deletions inside the private copy survive later steps and artifact reads. The
reserved namespace must not exist in source. Pipeline IDs identify logical executions;
deterministic paths and step names support native Workflow replay. SDK retries are explicitly disabled for these
commands; HoBo does not retry side effects across adapters. Commands use argument
quoting, confined working directories and per-command environment, and a protobuf wrapper that
retains exact exit code and both output streams even when a user command fails.

The portable artifact subset is regular files of at most one MiB. Artifact reads
reject symlinks in the path, use bounded base64 transport, and return the shared
SHA-256 checked artifact type. Files are transferred in 128 KiB chunks so the
native Workflow journal never receives a non-serializable log stream. Combined
stdout/stderr per command is limited to 192 KiB; total pipeline logs are limited to two MiB and total
artifacts to four MiB. Exceeding a bound fails the run, without
silent truncation. The adapter also bounds SDK string/stream decoding.
The SDK context already binds the source repository/revision. Arbitrary OCI image
selection, provider-specific source adapters, secret injection and deploy credentials
are not part of the portable pipeline contract.

Readiness is `implemented` and `EXECUTION_AVAILABLE` is `true`; this describes the
shipped adapter, not provisioned customer infrastructure or live provider evidence.
The remaining gates name deployment binding and live acceptance. Tests use native
SDK contract fixtures and actual local POSIX command execution, with no remote
provider resources, GitHub repository access or credentials.

Run `pnpm --filter @hobo/ci-cf build`, `typecheck`, `test` and `lint`.
`typecheck` includes the Worker example against actual upstream SDK/types;
`pnpm codegen:check -- --filter packages/ci-cf` checks protobuf/CUE drift.

Native SDK 0.2.0 destroys command sandboxes after output drains, but it catches
cleanup errors and does not expose randomized sandbox IDs through `CiContext`.
Normal completed commands can return their result; provider billing remains a usage
estimate. Authoritative cancellation/billing needs an application-owned controller
that can positively verify its Workflow and sandbox resources have stopped.

The native provider contract fixture deliberately restores original tracked files
before every local runner call. Tests prove the outer checkout is overwritten while
the private source retains both tracked-file mutations and deletions. Each session
call still executes only its requested step; future steps are not eagerly batched.
