# Default Role Action Matrix Contract

Independent HOBO-162 proof for the Plan 29 built-in role to action matrix and
separation-of-duties obligations.

This draft package pins:

- the six built-in roles from ADR-0074;
- Plan 29 default grants, using `hobo:<resource>:<verb>` action ids from the
  HOBO-154 taxonomy package;
- deny-by-default behavior for unlisted role/action tuples;
- policy-pack author-not-approver and two-person approval guards;
- prod Delta promotion approval and opener-not-promoter guards;
- `role:bind` no-self-escalation; and
- Operator-Supervisor `forge:execute` as a capped Crew-operator grant.

## Boundary

This package does not implement SSO/SCIM role binding, custom-role storage, the
obligation engine, policy-pack signing, or the full policy engine. It returns the
required obligations and denials at the contract boundary those slices consume.

## Verify

```sh
npm.cmd --prefix src/draft/exp-proofs/dx/default-role-action-matrix-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Default Role Action Matrix Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
