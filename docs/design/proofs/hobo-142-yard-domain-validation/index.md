# HOBO-142 Yard Domain Validation Proof

This executable proof pins the Yard-level domain resource and validation-check
skeleton from [Plan 12](../../security-networking.md#plan-12) and
[ADR-0035](../../adr/07-portability-extensibility.md#adr-0035).

## Contract Surface

- `domain("shop.com")` is a Yard-scoped, provider-global resource with
  per-Camp overrides.
- `.routes()` creates the gateway-facing route and shadow DNS record.
- `.routing()` carries the provider-agnostic DNS routing policy.
- Validation plugs into the existing HOBO-113 gate and runs all four checks
  before emitting `domain.Validated`.
- A failed check emits `domain.ValidationFailed` naming the failed check.

## Proof Boundaries

This is a branch-local contract proof. It does not promote the live DNS zone,
perform staged/canary cutover, issue or rotate certificates, realize concrete
cloud DNS/provider adapters, or federate cross-cloud domains through the
Junction.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\yard-domain-validation-contract test
```

The checks cover happy-path shadow validation, forced failures for each
required check, split-horizon multi-vantage disagreement, premature TTL
propagation, and proof that validation does not emit cutover/live routing
events.
