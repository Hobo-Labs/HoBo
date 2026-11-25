# HOBO-276 SRE Diagnose Projection Proof

HOBO-276 is proven by the focused POC at
[`src/draft/technical-proofs/sre-diagnose-projection-contract`](../../../../src/draft/technical-proofs/sre-diagnose-projection-contract/README.md).

## Acceptance Evidence

- An opened and triaged Incident is diagnosed from read-only projection
  snapshots (`slo_status`, `tail_logs`, `get_drift`), emitting
  `incident.RootCauseIdentified`.
- From-zero replay over the original Incident events plus the emitted diagnosis
  event rebuilds the same root cause.

## Adversarial Evidence

- Any engine write attempt during diagnose receives `capability.Denied`, emits
  no root-cause event, and creates `crew.HandoffRequested`.
- Stale or missing projection evidence returns `insufficient-evidence` and
  hands off instead of guessing a fix.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\sre-diagnose-projection-contract test
```
