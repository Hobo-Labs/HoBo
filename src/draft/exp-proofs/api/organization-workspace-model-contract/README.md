# Organization & Workspace Model Contract

HOBO-413 defines the M0 scope and acceptance record for the Organization & Workspace Model.

This POC records a machine-checkable M0 contract in `src/organization-workspace-model.mjs`:

- canonical account, organization, workspace, project, tenant, and environment vocabulary;
- primary personas and scope in/out rules;
- service, UX, security, and support boundaries;
- owning initiative dependencies for tenant/quota, RBAC, settings lifecycle, onboarding, and cutline work;
- M1 evidence requirements and a follow-up gate that blocks implementation fan-out before M0 acceptance.

Run:

```sh
npm --prefix src/draft/exp-proofs/api/organization-workspace-model-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Organization Workspace Model Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
