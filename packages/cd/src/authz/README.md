# `@hobo/cd/authz` — delivery authorization

Owner: WP19 (plan 0024, D15, I10, R14). Export: `@hobo/cd/authz`.

Every mutating `CdAction` is authorized before it changes anything. The
authorizer composes two packs through `@hobo/contracts`' `evaluatePolicyPack`
(the evaluator the Gatekeeper runs), most-restrictive-wins:

1. **CD baseline pack** (`createCdBaselinePack`, `hobo.cd/baseline@1.0.0`):
   exactly one rule per `CdAction` (`CD_ACTION_SPECS` is a
   `Record<CdAction, …>`, so a new frozen action is a compile error until it
   has a rule).
   - Agent principals, or any principal delegated by an agent, are
     **proposal-only** (`require-approval`) unless granted `cd:<action>` or
     `cd:*` (ADR-0094). `failover.propose` is itself a proposal, so an agent
     may make it without a grant.
   - **Separation of duties** (R14, I24): the principal holding one
     enrollment grant (`reconciler.approve-key` / `reconciler.accept`) for a
     reconciler is denied the other. A denied or proposal-only decision holds
     no grant.
2. **The Station's policy pack** (`policyPack`): any `@hobo/contracts` rules
   over `cd.<action>` requests. A pack `allow` never lifts a baseline
   `require-approval` or `deny`.

## Architecture

- **Command → event.** `authorize(action, subject, ctx)` is the command. Its
  only effect is a recorded `policy.Decided` event (`AUTHZ_DECIDED_EVENT`,
  body `hobo.cd.authz-decision/v1`) on the governed resource's decision
  stream `AUTHZ_STREAMS.resource(kind, id)` in the event store. One stream
  per resource means one writer per resource and short histories.
- **Read side.** `decisions(resource)` is the projection over a decision
  stream; the separation-of-duties check reads the same projection. Streams
  are short, so no snapshot or materialized view is kept; the read store is
  the journal itself.
- **Parse, don't validate.** `parseAuthzDecision` is the only way a journal
  body becomes an `AuthzDecision` (a parsed, derived type); foreign or
  malformed `policy.Decided` bodies are ignored, never trusted.
- **Deterministic (I8).** The decision id is a hash of action, principal,
  resource, scrubbed subject, tenant and the injected `now`. The same
  request at the same instant is one decision (idempotency key = decision
  id, I12).
- **Secret-free (I9).** Subject members whose names look like secrets
  (`secret|token|password|credential|private`) are dropped before evaluation
  and recording; `redacted` lists their paths.

## Results

| Effect | Result |
|---|---|
| `allow`, `allow-degraded`, `warn`, `mutate` | `{ ok: true, value: { decisionId, proposalOnly: false } }` |
| `require-approval` | `{ ok: true, value: { decisionId, proposalOnly: true } }` — the caller records a proposal only |
| `deny` | refusal; `reasons[0].subject` is the recorded decision id |

## Failure modes (`AUTHZ_FAILURES`)

| Code | When | Remediation |
|---|---|---|
| `cd-authz-denied` | A pack rule denied. | Read the recorded decision; request the grant from the pack owner. |
| `separation-of-duties` | Same principal tried both enrollment grants. | A second operator grants the other half. |
| `cd-authz-policy-error` | A rule threw. Denied, recorded. | Fix the rule. |
| `cd-authz-unrecorded` | The decision could not be read/recorded. Nothing changed. | Check event-store health; retry. |
| `cd-authz-unknown-action` | Not a frozen `CdAction`. | Use `CD_ACTIONS`. |
| `cd-authz-tenant-mismatch` | `ctx.tenant` ≠ the authorizer's tenant. | Route to that tenant's authorizer. |

## Metrics (through `TelemetrySink`)

- `hobo.cd.authz.decisions{action, effect, principal.kind}` counter.
- `hobo.cd.authz.refusals{action, reason}` counter.

A failing sink never fails a decision.

## Runbook

- **Agent actions keep landing as proposals.** Expected (ADR-0094). To let an
  agent act, add it to `agentGrants` (`{ "<agent id>": ["drift.remediate"] }`)
  in composition, scoped to the fewest actions; never grant `*` in prod.
- **`separation-of-duties` on enrollment.** The same operator approved the key
  and tried to accept the reconciler (or the reverse). Ask a second operator;
  do not disable `separateEnrollmentApprovers` outside single-operator dev.
- **`cd-authz-unrecorded` spike** (`hobo.cd.authz.refusals{reason=cd-authz-unrecorded}`).
  The event store is unavailable or contended; every mutation is refused until
  it recovers. Check store health (SQLite busy, Postgres reachability), then
  retry the refused commands; they are idempotent.
- **Audit a decision.** Take the decision id from the refusal's `subject` (or
  the caller's record), find the resource from the caller, and read
  `decisions({ kind, id })`: effect, reason, matched `policyIds`, pack id and
  version, and `inputHash` for replay.
