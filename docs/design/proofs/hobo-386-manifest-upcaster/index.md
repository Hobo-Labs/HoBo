# HOBO-386 Manifest Upcaster Proof

This branch extends `src/draft/technical-proofs/hobo-manifest-contract` with a versioned manifest upcaster contract.

Proof coverage:

- `hobo.manifest/v1` upcasts to `hobo.manifest/v1.1` through the public registry dispatch.
- The current schema records `manifestVersion.upcastedFrom` and validates after upcast.
- The upcasted manifest keeps deterministic content addressing: same input yields the same canonical hash.
- Unknown schemas, too-new targets, and missing intermediate upcasters fail closed with precise errors.
- Lossy upcasters must record explicit loss metadata; silent field drops are rejected.
- Already-current manifests are idempotent and do not double-upcast.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-manifest-contract test
```
