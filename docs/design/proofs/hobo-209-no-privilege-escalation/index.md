# HOBO-209 No Privilege Escalation Proof

This proof hardens the Plan 29 policy/RBAC boundary and ADR-0074/ADR-0096
deny-ceiling composition against privilege-escalation attacks. It also pins the
ADR-0080 tenant fail-closed invariant where unresolved `ctx.tenant` must stay a
deny path, not an implicit cross-tenant-admin path.

Proof package:

- `src/draft/technical-proofs/no-privilege-escalation-policy-contract`

Coverage:

- child pack attempts to un-deny a parent mandatory deny fail composition while
  the parent deny remains effective;
- federated mandatory pack ordering cannot change the effective mandatory deny
  set or hide the widening violation;
- `role:bind` cannot grant a target role whose grants exceed the binder, even
  after the binder chains a permitted lesser role onto itself;
- Crew repair operators stay bound to the `operator-supervisor` cap across
  repeated repair-loop attempts;
- unresolved `ctx.tenant` denies on the tenant-scoped path, while explicit
  cross-tenant-admin scope takes a distinct allow path;
- `identity.GenesisAdmin` is consumed once, and later self-grant attempts are
  denied.

Scope held:

- no new policy engine;
- no policy pack signing, distribution, or runtime federation;
- no cross-tenant data-store enforcement internals;
- no Crew runtime implementation.

Verification:

```powershell
npm.cmd --prefix src\draft\technical-proofs\no-privilege-escalation-policy-contract test
```
