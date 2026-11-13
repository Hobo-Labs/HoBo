# Many-active work (L04)

`@hobo/fleet/work` carries a unit of upstream work from a dispatcher to one executor (design §6.9, §6.11, §6.13). The package does not know what a job is: a *work kind* supplies a `WorkSource` (the dispatcher half) and a `WorkRunner` (the executor half). This directory ships the `oci-command` kind; `github-actions-job` lives in `@hobo/ci-gh-actions`.

## Entry points

| Function | What it does |
|---|---|
| `workDigest(kind, workKey)` | First 32 hex of `sha256(kind ‖ 0x00 ‖ work_key)` |
| `deriveTrustClass(offer, self)` | `UNTRUSTED` when the offer says so or its origin is not `INTERNAL`; `OWN` when the author (for submitted work, the author inside the authority's `WorkSubmission`) is the owner or one of the owner's linked identities in the device's own record; otherwise `ORG`. A dispatcher's `OWN` is ignored |
| `requiredSandbox(trust, class, policy, repository)` | The table of §6.11. A record without a device class counts as `PERSONAL` |
| `checkClaim(claim, subject, offer, context)` | The dispatcher's four rules, in order: `discard`, `not-entitled`, `early`, `valid` |
| `checkOrder(order, context)` | Every acceptance rule of §6.9 step 6; a refusal names its rule in `detail.check` |
| `checkAssignment(order, observed, self, policy, tier)` | The start fence of §6.9 step 7 |
| `createDispatcher(deps)` | The dispatcher loop |
| `createExecutor(deps)` | The executor loop |
| `createOciCommandSource(bus)`, `createOciCommandRunner()` | The `oci-command` kind |

## The claim rules

1. **Discard**, attributing nothing: wrong context, a signer the registry does not know, a signature that does not verify against the signer's `SIGN` key, a payload whose member, fleet, digest, dispatcher or offer expiry differs from the subject it arrived on or the offer it answers, or a fleet the registry does not know. Forged, replayed and cross-fleet claims land here, so a victim they name is never reported.
2. **Not entitled**, reported with the signed claim as evidence: the signer is not an `ACTIVE` `DEVICE`, is not an `EXECUTOR` in that fleet, is on a platform the work does not run on, is outside the fleet's or the offer's residency rule, or claims a tier below what §6.11 requires for the class it would derive. Capacity is advice (§6.8) and is never grounds for a report.
3. **Early**, deleted and counted: more than one rank (20 s) ahead of the claimant's turn. The turn comes from L03's `claimTurn` over the dispatcher's own ranking. With no ranking (the authority re-checking a report calls with `ranked: []`) or when the ranking leaves the claimant out, the rank the claimant signed into its claim is its turn. The time is the claim's own `claimed_at`, unless it lies in the reader's future. Three early claims from one device on one offer inside an hour are reported together, because a `ViolationReport` names one offer.
4. Otherwise **valid**: the dispatcher asks `stillWanted`, prepares the order for that claimant, seals the secret to the claimant's `SEAL` key with associated data `order_id ‖ 0x00 ‖ member_id`, signs and delivers.

## Policy

- `work_kinds` empty allows every kind, as the other lists of a fresh policy do.
- Work that names a repository needs a `RepositoryRule` for it (an empty list allows none), a ref one of the rule's globs matches (`*` stays inside one path segment, `**` crosses them; empty `refs` means none) and a workflow digest the rule lists (empty means any). Submitted work names no repository and skips these rules.
- Residency (ADR-0146) is fail closed: where the fleet or the offer carries a rule, an undeclared, unmapped or disallowed region excludes the device from ranking, makes its claim not entitled, and is refused by the device itself (`residency-denied`).
- A device below the fleet's `min_agent_version` is not ranked and does not claim; it logs `hobo_fleet_update_required`.

## Ranking

Candidates are the fleet's executors with an accepted, unexpired observation of themselves (L03's `acceptObservation`; an envelope already accepted is reused, expired ones are dropped first), at or above `min_agent_version`, inside the residency rules, and offering a tier at least what §6.11 requires for the class each would derive. Weights are `fitWork` copies times the reliability in the authority's fleet view (1 without a fresh view); the order is L03's `rankMembers`. Dispatchers rank among themselves the same way with weight 1, so one offers each unit and the next takes over one 20-second step later.

## The executor

For each offer in a fleet it executes in: verify the dispatcher's signature, fit (runner for the kind, policy, version, residency, a self-tested driver of an adequate tier, capacity less the slots it already holds), rank, and claim at its turn if the bus is connected and nobody holds the claim. It waits 30 s for the order. An order that passes `checkOrder` gets a fresh egress proxy and sandbox (host Docker only on a `DEDICATED` device in an `S1` sandbox under `allow_host_docker`), the start fence, the runner, log chunks of at most 64 KiB and receipts; the sandbox and proxy are destroyed afterwards. An order that fails a check after it is attributable to its dispatcher is answered with a `REFUSED` receipt naming the error code; a forged or replayed one is answered with nothing. Order ids are persisted in `AgentState.seenOrderIds`; receipts go to `AgentState.pendingReceipts` before they are published and leave it once published, so they survive a bus outage and a restart (F4).

With the bus down the dispatcher offers nothing and the executor claims nothing; running work continues and its receipts queue. The authority records from the streams when it returns.

## The `oci-command` kind

The source subscribes to `FLEET_SUBMISSIONS` for each fleet it is polled for, keeps the submissions the pinned trust record's authority keys signed, offers each unexpired one once (origin `INTERNAL`, author from the submission) and stops offering it once prepared. The order's parameters are `image` (with `@digest` when given), `argv` and `env` as JSON; the secret is empty. The runner executes `argv` in the sandbox, streams its output as log chunks and reports `sha256:<hex>` of the output as the output digest.
