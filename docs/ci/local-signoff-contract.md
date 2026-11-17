---
type: CI Verification Contract
title: "Local signoff in the CI fleet"
description: "Decision rules, failure cases, and evidence for the optional local signoff path."
tags: [hobo, ci, fleet, github, attestation]
---

# Local signoff in the CI fleet

`pnpm ci:attest fleet --local-signoff --policy-current` is an operator-invoked verification
alternative for a pull request, not a runner or an automatic outage daemon.
The fleet coordinator reads the committed runner policy, a routing slip, and a
bounded sample of GitHub's Actions queue. A runner decision reports the chosen
route; the workflow continues to own actual dispatch and batch admission. A
local-signoff decision runs the covered checks on the invoking machine and,
only after they pass, calls [basecamp/gh-signoff](https://github.com/basecamp/gh-signoff).
The [runbook](../../packages/ci/RUNNER-QUEUE.md#sign-off-without-an-actions-runner)
has setup and operational commands.

## Selection contract

A configured pin or valid pinned slip wins before availability is read. An
unpinned fleet slip requires a recent timely pickup on its exact label; a
`fleet-busy` slip permits a young backlog but not an old wait or a slow pickup.
A slip choosing a fallback records a fleet refusal, but a fresh healthy fleet
pickup takes precedence. A slip choosing an enrolled local runner does not
establish that it is taking jobs; the queue must establish its availability or
refusal. A GitHub slip does not rule out a local runner enrolled since the slip
was issued. An unusable, expired, unreadable, or tier/label-contradictory slip
leaves the queue rule to decide.

After pins and slips, availability means *observed* availability, not a
reservation or a guarantee that a runner will still be free. The generic
selector uses HoBo, ARC, local, then GitHub-hosted order. The checkout
coordinator also considers enabled provider and external-pool inventory from the
trusted base. Providers sharing a label remain separate observations. Capacity
with no useful queue evidence remains unknown unless the operator independently
observes its outage and names that enabled member with `--provider-unavailable=ID`.
Unsupported inventory stays unknown. An Actions workflow continues
to use its own PR batch capacity proof; the local coordinator does not create
that proof.

The candidates are general PR routes and enabled provider inventory. The
special `runnerRouting.boxRunner` label is reserved for the deps-image job and
is not a general PR route, so the local coordinator does not select it. That
job keeps its existing dispatch behavior and is not completed by a local status.

| Evidence for enabled tiers | Local signoff opted in | Result |
| --- | --- | --- |
| At least one observed available | Either | First available runner in fleet order |
| None available; at least one unknown | Either | Wait for availability evidence |
| All observed unavailable | No | Wait for capacity |
| All observed unavailable | Yes | With current policy asserted, run eligible local checks, then sign off only if they pass |
| Malformed or contradictory selector observations | Either | Wait for availability evidence |

Disabled members do not block the last two rows. The pure selector also treats
an empty enabled set as having no available or unknown members; the checkout
coordinator always includes fleet and GitHub-hosted members. Duplicate or empty
member IDs, unknown IDs, non-integer or negative enabled capacity, and a member
reported both unknown and available are malformed.

`--policy-current` is the operator's assertion that the enabled live offers,
their execution backends, desired policy, and running routing configuration
match the trusted base. The [local guide](../../packages/ci-gh-actions/LOCAL-DEVELOPMENT.md#local-signoff-in-fleet-routing)
explains the separate sources to inspect; an account status or offer response
alone does not establish the full comparison. If it cannot be verified, omit
the flag and local signoff waits. The base SHA used for this decision must also
be the base used for the local run and publication.

The optional `--github-unavailable` is an operator's observation that hosted
jobs fail before queueing. It supplies a hosted refusal only in the absence of
an observed healthy hosted pickup; it cannot override a pin, a selected runner,
or a failed queue read. Use it only with independent evidence of that outage.
`--runner-unavailable=fleet` and `--runner-unavailable=local` are scoped
operator observations for those tiers. Use them only with independent outage
evidence; they cannot override a pin, healthy pickup, or failed queue read.

## Failure and boundary cases

| Case | Behavior |
| --- | --- |
| Empty queue, no pickup, or a run ahead that has not chosen | Unknown where neither a refusal nor a pickup is established; wait when no other runner is available |
| Slip read fails | Use queue evidence; if the queue cannot be read, wait |
| Queue request fails or its response has no usable run or job array | Wait; do not infer that the fleet is down |
| Individual queue records are malformed or a running job has no runner identity yet | A separately observed healthy runner can still be selected; otherwise wait rather than infer an outage |
| Queue timestamps are invalid, use more than nine fractional digits, are reversed, or are more than 30 seconds ahead of the local clock | Treat the affected observation as incomplete; valid runner evidence can still win |
| Inventory is malformed or unsupported, policy is not verified current, or a provider has no availability evidence | Do not infer an outage; wait unless a runner or pin is selected |
| An enabled provider is independently confirmed unavailable | An assertion for its exact inventory ID counts it unavailable; healthy pickups and pins remain authoritative |
| A well-formed provider outage assertion names an unknown or disabled member | Do not use it to authorize fallback or suppress runner evidence; report it if no runner is selected |
| An outage option is malformed or duplicated | Reject it before making a selection |
| A silent fleet or local runner is independently confirmed unavailable | A scoped `--runner-unavailable` assertion counts that tier unavailable without overriding a pin or healthy pickup |
| A recent timely pickup names a candidate alongside other runner labels | Keep that candidate unknown for fallback; a multi-label pickup is not proof of a single-label route |
| More runs or jobs exist outside the sampled pages | The decision is based only on the bounded sample, not a complete inventory; recheck or use independent operational evidence |
| Local extension is missing or lacks `--commit` | Fail before starting the local run |
| Dirty checkout, base not contained in HEAD, stale remote base, changed HEAD, bad signature, or workflow/description drift | Refuse the relevant run or publication; do not post new success statuses |
| A local check fails, is interrupted, or changes tracked files | Fail the run; no new signoff is posted. Once a run starts it removes its earlier local record for that tree |
| Missing container engine or intentionally omitted jobs | Omit affected jobs, including the coupled PR impact group where applicable; do not report those jobs successful |
| Unknown GitHub values, a changed skipped action or helper, or no command executed for a job/event/shard | Omit or refuse the affected job; never claim coverage from a skipped check |
| A record predates per-event, individually executed command evidence | Rerun it before direct signoff; existing workflow-reuse verification remains compatible |
| GitHub status write fails partway through | Report failure; some individual statuses may already exist. Inspect GitHub before retrying |
| Base moves or a retry fails on the same SHA | Existing GitHub statuses do not automatically expire or disappear. Update the branch, rerun, and inspect old statuses |

The queue observation reads a single page of recent runs and one page per
selected run, with bounded lookups and timeouts. An old queued job eventually
stops being current evidence. These limits make the decision timely but do not
prove global runner absence. An operator must not treat a missing observation as
an outage or use the hosted outage flag without separate evidence.

A signoff requires the checkout's exact HEAD and tree, a signed local record for
the current live remote base and requested event, and equality between each
reported job, its workflow, and the trusted base policy. It verifies that the
GitHub target matches the base remote and that GitHub's live base matches the
tested base. Commands are executed individually, including repeated commands;
Turbo may still reuse its own cache unless `--fresh` is specified. The current
PR impact group is omitted because its shadow classifier depends on a GitHub
variable unavailable locally, even when a container engine is available.
The extension requires a pushed commit and a credential allowed to write commit
statuses. These statuses use the credential's authority, rather than the
base-branch trust list used for workflow-reuse attestations. Local commands run
with the invoking user's authority, so only run trusted code. Serialize local
runs in a checkout and inspect statuses after an interrupted publication.

Statuses are `signoff/hobo-ci/local/<event>/<job>` on the tested head. They are
separate from Actions job results, cannot complete queued jobs, and do not by
themselves satisfy HoBo's existing required checks or merge-queue policy. A
`merge_group` signoff on a PR head represents a local simulation, not a status
on GitHub's generated merge-group commit. No branch-protection rule is changed.

## Evidence and live boundary

- [`fleet-overflow.test.ts`](../../packages/ci/test/fleet-overflow.test.ts)
  exhausts all 512 combinations of four tiers in up, down, unknown, or disabled
  states and both opt-in settings, and checks malformed observations.
- [`fleet-signoff.test.ts`](../../scripts/test/fleet-signoff.test.ts) covers
  preference, pins, provider identity and ordering, shared labels, outage and
  policy assertions, stale or contradictory slips, malformed inventory, queue
  errors, base changes, and an end-to-end temporary checkout. That fixture runs
  a local command and records the signoff invocation through a fake `gh`; it
  also rejects a changed job policy. A separate executor test proves a failed
  run cannot invoke signoff.
- [`local-attest.test.ts`](../../scripts/test/local-attest.test.ts) covers
  signatures, target and base identity, trusted job policy, omitted jobs,
  per-event execution, repeated commands, failed retries, and `gh` publication
  errors. The real upstream extension has also been exercised against a mocked
  GitHub API; neither fixture establishes a live status on GitHub.

**Built, not yet proven in production:** a real local `ci-guard` run passed,
but GitHub returned HTTP 403 when the upstream extension attempted to create a
commit status. To establish that boundary, an operator with status-write
permission can use a clean, pushed PR branch, verify the current policy and
runner-outage evidence, run `pnpm ci:attest fleet --local-signoff --policy-current`
(adding `--github-unavailable` only when independently observed), and link the
decision and resulting statuses. Check which jobs were covered and whether the
repository's required checks and merge queue still need runners.
