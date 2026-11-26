# Bootstrap Installer Scope Contract

This package is the executable M0 proof for HOBO-428. It records the accepted
Bootstrap Installer scope, validates the required persona/scope/boundary/dependency
shape, and guards against implementation creep into production installer scripts,
live provisioning, account/auth implementation, first deploy execution, secret
collection, or uninstall cleanup.

The authoritative design record is
[`docs/design/bootstrap-installer.md`](../../../../../docs/design/bootstrap-installer.md).

## Proof

Run the focused proof with:

```powershell
npm.cmd --prefix src\draft\exp-proofs\bootstrap-installer-scope-contract test
```

The tests prove:

- user/business goal and primary personas are explicit;
- scope in/out, non-goals, and operating boundaries are recorded;
- dependencies map to the authoritative DX, walkthrough, dogfood, bootstrap, air-gap, and identity sources;
- owning initiative boundaries are named without taking adjacent scope;
- M1 evidence requirements are listed with owner, source, proof mode, and claim;
- follow-up M1-M4 issue creation is blocked until M0 acceptance;
- excluded live installer, provisioning, auth, deploy, secret, and cleanup implementation work is rejected.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Bootstrap Installer Scope Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
