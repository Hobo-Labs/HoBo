# HOBO-177 Per-App Tenant Routing Proof

This executable proof pins the per-app tenant routing slice from
[Plan 50](../../security-networking.md#plan-50),
[ADR-0035](../../adr/07-portability-extensibility.md#adr-0035), and
[ADR-0079](../../adr/02-identity-security.md#adr-0079).

## Contract Surface

- Gateway routing derives `ctx.tenant` before handler invocation from
  subdomain, tenant-scoped custom domain, `/t/<tenant>` path, or verified JWT
  tenancy claim.
- App subdomains require an issued wildcard certificate binding for
  `*.app.com`.
- Tenant-owned custom domains carry a tenant-scoped domain resource and
  certificate reference.
- Siloed and region-pooled tenants select their configured Camp and region as
  part of the routing decision.
- Unknown hosts, unresolved tenants, and verified claim/host mismatches deny
  before the handler is invoked.

## Proof Boundaries

This is a branch-local resolver contract. It does not implement new gateway,
DNS, ACME, or tenant lifecycle primitives. It also does not implement
ADR-0080 data isolation or collection scoping; this proof only supplies the
tenant routing context that those later gates consume.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\exp-proofs\per-app-tenant-routing-contract test
```

The checks cover subdomain routing with wildcard cert metadata, tenant-owned
custom-domain routing, path routing, verified-JWT claim routing, siloed
Camp/region placement, fail-closed unresolved requests, unknown-host denial,
and claim/host mismatch denial.
