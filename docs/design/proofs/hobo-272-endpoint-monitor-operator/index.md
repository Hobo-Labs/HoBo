# HOBO-272 Endpoint Monitor Operator Proof

HOBO-272 is proven by the focused POC at
[`src/draft/technical-proofs/endpoint-monitor-operator-contract`](../../../../src/draft/technical-proofs/endpoint-monitor-operator-contract/README.md).

## Acceptance Evidence

- A synthetic probe failure crossing the burn threshold emits `slo.BudgetBurned`
  and is consumed by the existing SRE skeleton, which dispatches SRE and opens
  one Incident.
- The Endpoint Monitor principal records probe access through `CredentialAudit`
  with `token.Granted` and `token.Used` evidence.
- `resource.DriftDetected` is carried into the same SRE signal stream when the
  operator has the required resource-read capability.

## Adversarial Evidence

- Flapping probes are grouped by resource and SLO into one `alert.Fired` event,
  avoiding alert-per-blip storms.
- A probe outside the operator `.allow()` scope emits `token.Denied` and no
  SLO, alert, or SRE signal.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\endpoint-monitor-operator-contract test
```
