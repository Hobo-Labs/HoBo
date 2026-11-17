---
type: CI Verification Contract
title: "Local signoff in the CI fleet"
description: "Decision rules, failure cases, and evidence for the optional local signoff path."
tags: [hobo, ci, fleet, github, attestation]
---

# Local signoff in the CI fleet

`pnpm ci:attest fleet --local-signoff` is an operator-invoked verification
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
A slip choosing an enrolled local runner refuses the fleet, but enrollment does
not establish that the local runner is taking jobs; the queue must establish
its availability or refusal. An unusable, expired, or unreadable slip leaves
the queue rule to decide. A slip choosing GitHub has already refused the
self-hosted tiers for that decision.

After pins and slips, availability means *observed* availability, not a
reservation or a guarantee that a runner will still be free. The generic
selector uses HoBo, ARC, local, then GitHub-hosted order. The checkout
coordinator models the configured fleet label, an enrolled local runner, and the
GitHub-hosted label. An Actions workflow continues to use its own PR batch
capacity proof; the local coordinator does not create that proof.

| Evidence for enabled tiers | Local signoff opted in | Result |
| --- | --- | --- |
| At least one observed available | Either | First available runner in fleet order |
| None available; at least one unknown | Either | Wait for availability evidence |
| All observed unavailable | No | Wait for capacity |
| All observed unavailable | Yes | Run local checks, then sign off only if they pass |
| Malformed or contradictory selector observations | Either | Wait for availability evidence |

Disabled members do not block the last two rows. The pure selector also treats
an empty enabled set as having no available or unknown members; the checkout
coordinator always includes fleet and GitHub-hosted members. Duplicate or empty
member IDs, unknown IDs, non-integer or negative enabled capacity, and a member
reported both unknown and available are malformed.

The optional `--github-unavailable` is an operator's observation that hosted
jobs fail before queueing. It supplies a hosted refusal only in the absence of
an observed healthy hosted pickup; it cannot override a pin, a selected runner,
or a failed queue read. Use it only with independent evidence of that outage.
No flag turns an unknown self-hosted tier into a known outage.

## Failure and boundary cases

| Case | Behavior |
| --- | --- |
| Empty queue, no pickup, or a run ahead that has not chosen | Unknown where neither a refusal nor a pickup is established; wait when no other runner is available |
| Slip read fails | Use queue evidence; if the queue cannot be read, wait |
| Queue request fails, is not JSON, or lacks its `workflow_runs` or `jobs` array | Wait; do not infer that the fleet is down |
| More runs or jobs exist outside the sampled pages | The decision is based only on the bounded sample, not a complete inventory; recheck or use independent operational evidence |
| Local extension is missing or lacks `--commit` | Fail before starting the local run |
| Dirty checkout, base not contained in HEAD, stale remote base, changed HEAD, bad signature, or workflow/description drift | Refuse the relevant run or publication; do not post new success statuses |
| A local check fails, is interrupted, or changes tracked files | Fail the run; no new signoff is posted. Once a run starts it removes its earlier local record for that tree |
| Missing container engine or intentionally omitted jobs | Omit affected jobs, including the coupled PR impact group where applicable; do not report those jobs successful |
| GitHub status write fails partway through | Report failure; some individual statuses may already exist. Inspect GitHub before retrying |
| Base moves or a retry fails on the same SHA | Existing GitHub statuses do not automatically expire or disappear. Update the branch, rerun, and inspect old statuses |

The queue observation reads a single page of recent runs and one page per
selected run, with bounded lookups and timeouts. An old queued job eventually
stops being current evidence. These limits make the decision timely but do not
prove global runner absence. An operator must not treat a missing observation as
an outage or use the hosted outage flag without separate evidence.

A signoff requires the checkout's exact HEAD and tree, a signed local record for
the current live remote base and requested event, and equality between each
reported job and its workflow description. The operator must confirm that
`gh repo view` names the intended target repository; the selected GitHub
repository and the base remote are not automatically proven to be the same.
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
  preference, pins, unavailable and unknown tiers, outage assertions, exact
  slip labels, an unavailable local runner, young backlogs, queue errors,
  malformed queue envelopes, and an
  end-to-end temporary checkout. The end-to-end case executes a real local
  command, records the signoff invocation through a fake `gh`, and proves that
  a failing local command does not invoke signoff.
- [`local-attest.test.ts`](../../scripts/test/local-attest.test.ts) covers
  signatures, exact head/base, workflow parity, omitted jobs, failed retries,
  and `gh` publication errors. The real upstream extension has also been
  exercised against a mocked GitHub API; neither fixture establishes a live
  status on GitHub.

**Built, not yet proven in production:** no live GitHub status has been posted
through this integration. To establish that boundary, an authorized operator
can use a clean, pushed PR branch with the extension installed, record the
runner-outage evidence, run `pnpm ci:attest fleet --local-signoff` (adding
`--github-unavailable` only when independently observed), and link the fleet
decision and the resulting commit statuses. Check which jobs were covered and
whether the repository's required checks and merge queue still need runners.
