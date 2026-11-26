# Chaos & Resilience Tests Scope Acceptance

Independent proof for HOBO-439. It pins the M0 scope, personas, boundaries,
M1 evidence requirements, follow-up gate, and scope-creep refusals for the
Chaos & Resilience Tests productization project.

## Acceptance Coverage

- goal and personas are explicit for SRE, release, platform, security, and
  support users;
- service, UX, security, and support boundaries are mapped;
- owning initiative dependencies are named without taking their implementation
  scope;
- M1 evidence is listed before design/contract proof work can start;
- M1-M4 follow-up work is blocked until HOBO-439 M0 acceptance is recorded.

## Negative Coverage

- live chaos runner, production fault injection, provider adapter, and external
  chaos engine work are rejected as scope creep;
- Golden Suite, SLO engine, SRE remediation, dashboard, support workflow, and
  credential mutation work route to their owning projects instead of HOBO-439.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\chaos-resilience-tests-scope-acceptance test
```
