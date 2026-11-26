# HOBO-399 Bindles API Freeze Proof

The proof lives in `src/draft/technical-proofs/bindles-api-freeze-contract`.

It freezes:

- the `@hobo/bindles` public API snapshot;
- the adversarial edge matrix for narrowing, coverage, XAA, raw escape hatches,
  provider `.with()` inertness, and combined narrowing plus coverage;
- the representative `hobo.manifest/v1` golden IR shape.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\bindles-api-freeze-contract test
```
