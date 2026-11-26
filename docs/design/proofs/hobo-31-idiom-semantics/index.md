# HOBO-31 Idiom Semantics Annex Proof

This proof records the HOBO-31 spike decision: SDK parity has two independent lanes.

- Golden-IR lowering equivalence proves identical `hobo:sdk` WIT calls and `hobo.manifest/v1`.
- The semantics annex proves language control-flow behavior that golden IR cannot see:
  error mapping, cancellation, async ordering, and IfC side-effect order.
- A wrong TypeScript adapter that swallows a WIT `result.err` must fail the annex even if it lowers
  to identical WIT calls and manifest IR.

Executable proof bundle: [`../../../../src/draft/technical-proofs/idiom-semantics-annex`](../../../../src/draft/technical-proofs/idiom-semantics-annex).

**Draft POC (HOBO-614):** annex vectors and `runSemanticsAnnex` ported to [`../../../../src/draft/projects/s1-24-conformance-sdk/src/sdk`](../../../../src/draft/projects/s1-24-conformance-sdk/src/sdk).

Focused verification:

```powershell
npm.cmd --prefix src\draft\technical-proofs\idiom-semantics-annex test
```
