# HOBO-220 End-User Authorization Policy Proof

This proof records `src/draft/technical-proofs/end-user-authorization-policy-contract` for the
M2 end-user authorization slice described by
[Plan 29](../../contracts-policy-flags.md#plan-29) and
[ADR-0038](../../adr/02-identity-security.md#adr-0038).

## Acceptance Evidence

- A verified `ctx.user` becomes a `DecisionRequest.subject` with
  `kind=user`, roles, scopes, and tenant context.
- Owner-read rules allow the verified owner to read their own record and deny
  another user's record through the built-in policy engine.
- Raw request-body user and owner claims are not exposed as trusted policy
  input, so they cannot forge the verified subject.
- Missing or unresolved `ctx.user` fails closed before user policy rules run.
- `.allow()` is authoring shorthand that lowers to the same typed user-claim
  policy rule, with no second authorization evaluator.
- Every outcome is wrapped by the canonical `policy.Decided` event.

## Scope Guard

This POC does not verify identities, fetch JWKS, build sessions, implement the
cross-tenant app conformance gate, or replace the built-in policy engine. It
only consumes verified `ctx.user` claims and proves the policy-plane lowering.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\end-user-authorization-policy-contract test
npm.cmd test
```
