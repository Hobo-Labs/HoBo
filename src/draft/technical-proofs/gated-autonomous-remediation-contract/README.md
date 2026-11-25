# Gated Autonomous Remediation Contract

Independent POC for HOBO-284. It proves the SRE write path after HOBO-280's
decision tree has produced a remediation action:

1. evaluate the action through the policy plane;
2. hold production or otherwise gated actions behind a replayable approval
   obligation;
3. after `policy.Decided(effect=allow)`, emit `crew.ActionApplied` and run the
   live-fix canary through the existing rollout saga template;
4. roll back on SLO/Golden regression and install a same-action cooldown guard.

## Executable Proof

```powershell
npm.cmd --prefix src\draft\technical-proofs\gated-autonomous-remediation-contract test
```

The tests cover the acceptance and adversarial cases from HOBO-284:

- low-risk remediation auto-applies as a canary and rolls back on injected
  regression;
- the same failed remediation is not immediately re-proposed;
- production remediation waits for approval and applies only after a new allow
  decision;
- replay rejects `crew.ActionApplied` without a matching allow policy decision.

## Scope Boundary

This package does not implement the live-fix candidate engine, SRE diagnosis,
the approval UI, or vendor paging. It consumes those seams and records the
contract facts that downstream implementations must preserve.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Gated Autonomous Remediation Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
