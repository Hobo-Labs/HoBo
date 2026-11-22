# Run HoBo CI on a development machine

The [Pact Broker validation lane](contracts/LOCAL-RUNNER-PACT.md) runs the local
scenario corpus, publishes generated integration contracts, verifies HoBo's
provider and enforces version compatibility. Unverified GitHub provider results
block its deployment gate.

## Local signoff in fleet routing

HoBo's fleet can offer local verification with
[basecamp/gh-signoff](https://github.com/basecamp/gh-signoff) when no runner
tier is available. After verifying the live policy as described below, run
from an up-to-date branch:

```sh
gh extension install basecamp/gh-signoff
git fetch origin
git merge origin/main
git push
pnpm ci:attest fleet --local-signoff --policy-current
```

Run these from the HoBo checkout, with `gh` authenticated for the target
repository, permission to write commit statuses, and `git user.name` set. The
last command reads the fleet routing slip and GitHub's queue. It prefers the
normal fleet, enabled overflow, local runner and GitHub-hosted routes. It reads
the routing policy and provider declarations from the committed base, not the
pull request's unmerged files. Only when all enabled runner tiers are known
unavailable does it run local checks and call `gh signoff`; unknown availability
means wait. Before passing `--policy-current`, inspect the live account and
offers with an account credential authorized for `policy:read`: use the
authenticated `GET /v1/accounts/self/policy` endpoint on the configured relay,
or `createCiRelayClient().getPolicy()`. Keep credentials out of shell history
and output. That response does **not** expose the separately stored desired
policy, its tenant, or the routing pin.

Also verify the currently effective desired policy from the relay operator's
authoritative store and the routing policy loaded by the running daemons. The
desired policy is stored as `ci-policy:<account-id>`; the daemon reads its
checkout's routing policy at startup. The account endpoint and `hobo ci status`
or mesh output alone cannot establish those values. Compare the actual enabled
providers and routing with the enabled base entries for every relevant account
and environment, including account, tenant, provider identity and kind, runner
label, execution backend, and pin. An enabled Kubernetes ARC scale set must
match a live offer with the `gh-actions` backend; an opaque or mismatched
backend cannot establish current inventory. A disabled base entry does not
cover an enabled live offer.
The flag is your assertion that this comparison is current; it does not detect
policy drift automatically. If any of those values cannot be verified, omit it:
available runner choices are still reported, but local signoff waits. The exact
base used for this decision must still match the remote before the local run
and before signoff.

The GitHub repository selected by `gh` must match the base remote. In a fork
checkout, set `GH_REPO` to the base repository (for example,
`GH_REPO=github.com/Hobo-Labs/HoBo`) and use `--base=upstream/main` when that
is the intended remote branch. The tested commit must be reachable from a live
branch on that base remote, or be the exact current head of an open pull request
against the tested base. Fork and same-repository pull requests are supported
when their head repository and branch are readable. The coordinator discovers
the pull request from the current branch, or accepts `--pr=123` (also useful in
a detached checkout). If a target branch has advanced, fetch it so its tip is
known locally. An inaccessible, closed, moved, or retargeted pull request is
refused. A status remains on the tested commit if the pull request later moves.

The coordinator interprets routing and provider inventory, not the complete
project policy schema. Malformed inventory, unsupported provider references,
or environment templates leave availability unknown. Unrelated policy fields
do not establish capacity; the live comparison remains necessary even when the
inventory is readable.

Enabled Actions overflow labels need current queue evidence: a recent timely
pickup with no queue refusal chooses that runner; a stalled queue or slow pickup
counts as refusal; an empty queue is unknown. The committed policies of all
declared environments are considered conservatively. When a provider's
availability is unknown, an operator who has separately confirmed that it is
unavailable can pass `--provider-unavailable=ID` for that specific enabled
inventory member. IDs are `ENV:PROVIDER` for policy providers,
`integration:ID:LABEL` for integrations, and `external-pool:INDEX:LABEL` for
external pools. Repeat the option for each confirmed outage. This is an
operator assertion, not a probe. Unknown or disabled IDs cannot authorize
fallback and are reported if no runner is selected. Malformed or duplicate
options are rejected before selection. A valid assertion cannot override a pin
or an observed healthy runner. Omit it when the outage cannot be verified.
If the queue is silent and the routing slip cannot establish whether the fleet
or an enrolled local runner is available, an operator who has independently
confirmed that tier is down can pass `--runner-unavailable=fleet` or
`--runner-unavailable=local`. Repeat the option for each confirmed outage.
These assertions do not override pins or observed healthy pickups; a failed
queue read still causes a wait.
If hosted jobs fail before queueing, an operator who observed that outage can
pass `--github-unavailable`
alongside `--local-signoff`; an observed healthy hosted runner still wins.
An unpinned fleet slip is checked against current queue evidence for its exact
runner label. A busy-fleet slip permits a young backlog, but still requires a
recent timely pickup. A fallback slip records a fleet refusal, but a fresh
healthy fleet pickup takes precedence. A slip naming an enrolled local runner
does not prove that runner is available; the queue decides for it. An unpinned
GitHub slip does not rule out a newly enrolled local runner. Slips whose
tier and runner label disagree are ignored.
If the slip cannot be read, the queue rule decides; if the queue cannot be read,
the command waits. GitHub's separate PR batch admission still applies to
Actions jobs.
The command reports a runner choice but does not dispatch, relabel, cancel, or
complete an Actions job. A missing container engine leaves container-dependent
jobs out of the local signoff, including the coupled PR impact group. When a
container engine is available, that group can be signed only when its trusted
base policy, workflow and skipped classifier dependencies match the tested
head. Classifier inputs must be regular tracked files, and tracked pnpm hooks,
module trees, patches, or other unreviewed resolution paths cause the group to
be omitted. The local run leaves out only the report-only shadow-classification steps;
it still runs the covered checks. Local tools and installed dependencies must
be trusted, and a new skip policy takes effect only after it reaches the base.
The reviewed workflow and local plan are pinned in the verifier; changes to
either require reviewing and updating those pins. Standalone runs, publication,
and workflow reuse apply this protection too. If an older base or incomplete
GitHub tree response cannot prove the policy, the PR impact group runs in
Actions; independently covered jobs can still be reused.

These are `signoff/hobo-ci/local/<event>/<job>` commit statuses, not GitHub
Actions job results. They need GitHub API access and a pushed commit, but no
Actions runner or relay. They do not satisfy HoBo's existing required Actions
checks or the merge queue's generated commit. Using local evidence to unblock
merges would require a separately reviewed protection and trust policy bound to
the commit being merged. See the
[signed local runs runbook](../ci/RUNNER-QUEUE.md#signed-local-runs-ci-on-your-own-machine)
for the exact scope, prerequisites, and limitations, and the
[selection contract](../../docs/ci/local-signoff-contract.md) for edge cases
and validation evidence.

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
[relay mesh](urn:hobo:requirement:ci-relay-mesh), where the relay's node list
and `hobo ci status` show it beside the box workers; `HOBO_CI_MESH_NODE_ID`
names it (default `local-<host name>`). Without `HOBO_CI_NATS_URL` nothing is
sent anywhere, and `status` and `hobo ci status` still answer from the file,
with no relay or network. A mesh that cannot be reached never stops the runner.
The machine advertises `HOBO_CI_LOCAL_REPOSITORY`, so the relay shows it in
full only to the account that owns that repository.

The key is inside the repository's checkout, where every job that runs on this
machine can read it. If the mesh's operator lists it, it must be bound to this
machine's node id (`mesh:trust add <key> --node local-<host>`), never added
with `--any-node`. `HOBO_CI_MESH_RELIABILITY_RESET=<token>` clears this
machine's reliability record once, as for a box worker.

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
