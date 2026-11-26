# HOBO-366 Drift Detection Loop Proof

This branch adds `src/draft/technical-proofs/drift-detection-loop-contract`, an independent executable POC for
the periodic ResourceActor refresh -> DriftReport -> reconcile loop.

It proves:

- A drifted managed resource records `resource.DriftDetected`, enters `resource.Updating`, and
  re-converges to `resource.Provisioned`.
- A clean refresh is a no-op, and repeated clean resyncs remain idempotent.
- Drift observed while another deploy holds the single-writer lease is serialized as queued drift.
- Refresh failures are classified and scheduled for retry without dispatching apply work.
- Repeated identical drift is suppressed by fingerprint so flapping refreshes do not oscillate.
- `external` and `echo` resources are drift-detect only and never re-applied.

Scope kept out: drift-conflict handling, tag-based orphan sweep, real driver/IaC refresh
implementations, cost/observability cadence tuning, and provider-specific retry machinery.

Verification:

```powershell
npm.cmd --prefix src\draft\technical-proofs\drift-detection-loop-contract test
```
