# Run HoBo CI on a development machine

The local runner controller (`hobo-local-host`, `pnpm local:runner`) is gone.
A development machine now joins a HoBo Fleet as an enrolled `PERSONAL`
executor and runs `hobo fleet run`; it takes the work its owner authored and
runs each job in a single-use sandbox (sandbox tiers).

- Quick start (enrolling a machine and `hobo fleet run`):
  [docs/maintenance/fleet/quick-start.md](../../docs/maintenance/fleet/quick-start.md).
- The standing description: HoBo Fleet, and its
  sandbox tiers.
- The device agent's parts (sandbox drivers, egress proxy, key stores, service
  install): [`@hobo/fleet-agent`](../fleet-agent/README.md).
- The relay's own local contract and broker gate:
  [contracts/LOCAL-RUNNER-PACT.md](contracts/LOCAL-RUNNER-PACT.md).

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
or `hobo fleet status` alone cannot establish those values. Compare the actual enabled
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
