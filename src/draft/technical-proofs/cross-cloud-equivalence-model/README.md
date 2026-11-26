# Cross-Cloud Equivalence Model POC

Independent POC for HOBO-108. It pins the M0 decision for provider-owned equivalence entries and a shared, deterministic capability resolver.

## Contract Surface

- Provider packages own equivalence entries as default Resource Definitions.
- The Registry indexes those entries into a catalog snapshot; the resolver is a pure function of that snapshot and the port request.
- `satisfies(request, entry)` returns `full`, `partial`, or `none`.
- `partial` may satisfy `prefer` features with a warning; missing `require` features reject the candidate.
- Extension entries add new provider/resource classes without editing a central enum.

## Scope Boundaries

This POC does not implement concrete providers, IaC emission, region ranking, Matching specificity scoring, or conformance execution. It proves the equivalence and negotiation model those later slices consume.

## Verification

```powershell
npm.cmd test
npm.cmd --prefix src\draft\technical-proofs\cross-cloud-equivalence-model test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Cross Cloud Equivalence Model.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
