# HOBO-32 SDK Idiom Conformance Gate Proof

This proof records the HOBO-32 implementation: `@hobo/conformance/sdk` has one gate for
hand-authored and generated idiom layers over `hobo:sdk`.

- Golden-IR lowering equivalence compares the idiom layer against canonical `hobo:sdk` calls and
  `hobo.manifest/v1` IR using the HOBO-106 corpus.
- The semantics-annex lane runs the HOBO-31 vectors for error mapping, cancellation, async ordering,
  and IfC side-effect order.
- A divergent lowering fixture fails the golden-IR lane.
- A semantics leak that still lowers correctly fails the annex lane.
- The report is explicit that golden-IR parity is bounded by the checked corpus; off-corpus behavior
  needs annex vectors or an unsupported-behavior callout.

Executable proof bundle: [`../../../../src/draft/technical-proofs/sdk-idiom-conformance-gate`](../../../../src/draft/technical-proofs/sdk-idiom-conformance-gate).

**Draft POC (HOBO-614):** [`../../../../src/draft/projects/s1-24-conformance-sdk`](../../../../src/draft/projects/s1-24-conformance-sdk) — five-lane gate without resilience-semantics; promotion target `packages/conformance/src/sdk/`.

Focused verification:

```powershell
npm.cmd --prefix src\draft\technical-proofs\sdk-idiom-conformance-gate test
```
