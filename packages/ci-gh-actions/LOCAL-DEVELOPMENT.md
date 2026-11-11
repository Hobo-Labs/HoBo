# Run HoBo CI on a development machine

The [Pact Broker validation lane](contracts/LOCAL-RUNNER-PACT.md) runs the local
scenario corpus, publishes generated integration contracts, verifies HoBo's
provider and enforces version compatibility. Unverified GitHub provider results
block its deployment gate.

HoBo can dispatch its existing companion workflow to an owned Linux x64 dev
machine. The machine hosts one job at a time. The persistent service registers
disposable official GitHub runners with **`hobo-local-host`**; the companion
workflow obtains the existing lease-bound JIT **`hobo`** runner. Original
workflows keep `runs-on: hobo`, job logs, artifacts and checks. Never attach the
service directly to `hobo`: that would bypass HoBo's reservations.

## Default dev container

Rebuild/open `.devcontainer/devcontainer.json`. It uses Node 24 Bookworm, installs
the native runner dependencies, GitHub CLI and Docker in Docker, and installs
checksum-pinned act v0.2.89 into `.tools/ci` on PATH. Each container start calls
the local runner service automatically. No GitHub credential is needed to open
the container or run the offline conformance workflow.
Corepack's pnpm shims also live in `.tools/ci`, so creation runs as the nonroot
`node` user without writing to `/usr/local/bin`.

For real GitHub jobs, supply these **non-secret** host environment variables
before opening the container, or export them in its terminal before starting
the service:

```sh
export HOBO_CI_LOCAL_REPOSITORY=owner/private-repo
export HOBO_CI_LOCAL_TRUSTED=1
```

Authenticate `gh` inside the container with repository administration permission
(a fine-grained token needs repository Administration write). Use an existing
approved CLI credential binding or `gh auth login`; do not commit credentials.
The controller uses `gh api --hostname github.com`. The matching jobs must all be
trusted with this dev machine, its filesystem, Docker daemon and credentials
available from disk. A fresh HOME and filtered environment reduce accidental
credential inheritance; they are **not** a sandbox against same-user jobs.
The local host refuses public repositories. Labels cannot prevent an untrusted
workflow from requesting a shared runner. Use the isolated hosted backend for
public, fork and pull-request workloads.

From the repository root:

```sh
node --import tsx packages/ci-gh-actions/scripts/local-runner.ts start
node --import tsx packages/ci-gh-actions/scripts/local-runner.ts status
node --import tsx packages/ci-gh-actions/scripts/local-runner.ts stop
```

`pnpm --filter @hobo/ci-gh-actions local:runner start|status|stop` provides the
same commands. After changing exported variables, stop and start the service so
it receives the new environment. Set `HOBO_CI_LOCAL_RUNNER=0` before opening the
container to disable automatic startup. Without repository trust/configuration
or GitHub credentials, the service reports `waiting` and retries every 30
seconds; it does not register a runner. The official runner archive downloads
on first configured use, is SHA-256 checked on reuse, and is extracted into a
fresh workspace/HOME for every host job. Only Linux x64 can host the current
HoBo bridge; Linux/macOS x64/arm64 can install act for offline workflows.

**This machine as a mesh node.** The service keeps an identity key
(`mesh-node.key`, mode `0600`), a small SQLite journal for its reliability
record (`mesh-node.sqlite`) and its own node report (`mesh-node.json`) in the
same directory. The report says what `status` shows under `mesh`: one slot
under `hobo-local-host` (free while a runner waits for a job), free memory and
disk, and the share of its sessions whose runner ran to its own exit. With
`HOBO_CI_NATS_URL` set it also advertises that, signed, to the
[relay mesh](../../docs/design/ci-relay-mesh.md), where the relay's node list
and `hobo ci status` show it beside the box workers; `HOBO_CI_MESH_NODE_ID`
names it (default `local-<host name>`). Without `HOBO_CI_NATS_URL` nothing is
sent anywhere, and `status` and `hobo ci status` still answer from the file,
with no relay or network. A mesh that cannot be reached never stops the runner.

Status/logs and the verified archive live under ignored `.hobo/ci-local/`.
`registered` means GitHub issued the registration; check `runner.log` for the
runner's actual GitHub connection. An OS lock makes repeated/concurrent starts
idempotent. Control uses a private Unix socket, not an unauthenticated TCP port.
Stop forwards cancellation to the process group and waits for cleanup before
returning `stopped`; unconfirmed cleanup returns a failure.
The same drain applies to programmatic abort signals. A retained registration
keeps both the saved status and `stop` result blocked until cleanup succeeds.
Runner names are unique; this service never replaces another developer's runner.
An idle listener has no age-based execution deadline: a job accepted after a
long idle period receives its full companion-workflow/lease timeout. Explicit
stop still drains the process group with a bounded shutdown deadline.

## Connect the local provider

Use an independently configured trusted-private HoBo relay and its ordinary
repository setup/activation flow. The runner only needs outbound GitHub access;
real GitHub webhooks and lease callbacks still need the relay's public HTTPS URL.
A loopback relay without a public tunnel supports simulated delivery only.

Declare a desired-policy provider with `kind: "local"`, an operator-owned
`connectionRef`, and `runsOn: "hobo-local-host"`. Its corresponding observed
account offer uses:

```json
{
  "id": "dev-machine",
  "provider": "local",
  "providerAccountId": "owned-dev-machine",
  "backend": "gh-actions",
  "runsOn": "hobo-local-host",
  "enabled": true,
  "bridgeAcknowledged": true,
  "concurrency": 1,
  "freeMinutes": 0,
  "priceMicrosPerMinute": 0,
  "budgetMicros": 0
}
```

This is an offer fragment, not a complete account configuration. Supply its
existing required observation, expiry, evidence and usage fields through
the account configuration API. Publish fresh workstation availability evidence;
the service does not manufacture availability or refresh relay policy. The
configuration parser rejects a shared label, paid local price, advertised free
credits, concurrency above one, and a non-Actions backend. Zero account budget
can admit this zero-price local offer. Enable **only local** in the development
account when CI should always use the dev machine: the scheduler still prefers
usable measured provider free credits when cloud offers are also enabled.

Use one active relay for a repository's `hobo` pool. Two local workspaces should
use separate development repositories/accounts rather than competing relays for
the same original job label. A disconnected/sleeping workstation cannot execute
its dispatched host workflow; normal lease timeouts and reconciliation apply.
Keep the local offer disabled or expire its availability evidence while away.
The local runner does not independently receive or bypass HoBo's admission API.

## Offline workflow development

Run the repository-owned workflow and full provider corpus without a GitHub App,
GitHub login, Docker image pulls or a public tunnel:

```sh
pnpm exec turbo run build --filter=@hobo/ci-gh-actions --concurrency=100%
node --import tsx packages/ci-gh-actions/scripts/act-harness.ts --act .tools/ci/act
```

Exercise the shipped relay service and local-provider lifecycle end to end:

```sh
node --import tsx packages/ci-gh-actions/scripts/acceptance.ts --local --act .tools/ci/act
```

This executes two original workflow jobs through admission, the dispatch outbox,
signed OIDC/JIT claims, process execution, cleanup and zero-price settlement. It
then disables local capacity, proves that no further host launches, and reopens
the durable store to check replay. GitHub APIs and identity issuance use strict
local fixtures; this does not establish live GitHub assignment. `--fault skip-job`,
`--fault wrong-provider` and `--fault missing-jit` must each fail acceptance.

The dev container performs that filtered build during creation; an ordinary
checkout needs it before first use so the workspace dependency exports exist.

The local scenario executes with zero budget. The complete corpus verifies
dependency outputs, matrix shards, continued failure and artifact contents.
For an explicitly reviewed custom workflow, act also supports native execution:

```sh
act workflow_dispatch -W path/to/reviewed-workflow.yml -P hobo=-self-hosted
```

Native act executes commands with the invoking user's authority. Review the
workflow and its local env/secrets files first. For container actions/services,
use act's Docker execution and explicit platform image mappings; Docker in Docker
is available in the dev container. act does not reproduce GitHub OIDC, queue
assignment, hosted artifact services, approvals or provider billing. Use the
existing acceptance workflow to verify a real connected GitHub job separately.

## Recovery and development scenarios

| Scenario | Behavior |
| --- | --- |
| No auth, offline, or API permissions revoked | Waiting/error status; no synthetic success; retry after 30 seconds |
| Two starts or two jobs | One controller lock; one host per local offer; further jobs remain queued |
| Job fails or normal stop | Process group stopped; registration deleted; disposable workspace removed |
| GitHub already removed the JIT runner | DELETE 404 is successful cleanup |
| Cleanup API unavailable | Retain repository/runner ID; retry DELETE before any new registration |
| Registration response lost or truncated | Retain unique runner name and block new registrations until the unknown outcome is reconciled |
| Hard kill, container interruption or unconfirmed process shutdown | Retain uncertain registration and workspace; block automatic re-registration |
| Repository changes with unfinished cleanup | Refuse new target until the previous registration is drained |
| Workstation sleeps or offer expires | GitHub/relay timeout and reconciliation; no assumed live capacity |
| ARM dev container | Offline act available; current Linux x64 bridge stays waiting with explicit reason |

Stop the service before rebuilding or interrupting the container. For an uncertain
registration, first verify that the previous container and all host/job processes
are stopped. In `.hobo/ci-local/registration.json`, change `uncertain` to `false`
only after that verification, keeping the recorded repository and runner ID.
Restart with the original repository configured; the service then removes that
registration before creating another. Never delete the record just to bypass
the fence. Orphaned scratch directories can be removed after confirming shutdown.

If `registration.json` has a runner `name` without an `id`, GitHub may have created
the registration without returning its credential. No local listener was launched.
Find that exact unique name in the repository's Actions runner settings, verify
it is inactive, and remove it if present. Only after reconciling that unknown
outcome may you clear this name-only record and restart. Known GitHub 4xx
registration refusals remain retryable; network failures and malformed replies
do not authorize creating another runner. An `unknown` control status likewise
does not confirm shutdown; `stop` fails rather than reporting successful drain.

Validation covers the TypeScript configuration/runtime parsers, generated
Protobuf offer/policy contracts, CUE valid/invalid local-offer fixtures, and the
relay consumer/provider dispatch/JIT contract (`test/local-provider.test.ts`).
`test/local-runner.test.ts` exercises a real subprocess fixture and cleanup
failures. GitHub CLI REST wire behavior is covered by the local runner API
contract; real GitHub permissions/assignment remain a live acceptance boundary.
The controller's private operational recovery file is parsed with Zod; it is
not a new CI journal/event projection or a public protobuf API.
