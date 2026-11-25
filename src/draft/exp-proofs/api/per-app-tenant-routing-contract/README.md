# HoBo per-app tenant routing POC

This draft implements HOBO-177: resolving an app tenant at the gateway before
the handler receives a request.

## Scope

- Resolve `ctx.tenant` from an app subdomain such as `acme.app.com`.
- Resolve a tenant from a tenant-scoped custom domain resource.
- Resolve a tenant from `/t/<tenant>` path routing on trusted gateway hosts.
- Resolve a tenant from a verified JWT tenancy claim on trusted gateway hosts.
- Bind wildcard `*.app.com` certificate metadata for app subdomains.
- Select the tenant's configured Camp and region for pooled, region-pooled, and
  siloed placement modes.
- Fail closed when no tenant is resolvable, a host is unknown, or a verified
  tenancy claim conflicts with the host/path-selected tenant.

## Out of Scope

- Tenant lifecycle and domain lifecycle orchestration.
- Gateway, DNS, or certificate primitive implementation.
- Data access scoping, collection filtering, or tenant isolation gates from
  ADR-0080.
- Runtime ingress adapters or public ACME calls.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\per-app-tenant-routing-contract test
npm.cmd test
```

Proof note: `docs/design/proofs/hobo-177-per-app-tenant-routing/README.md`.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Per App Tenant Routing Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
