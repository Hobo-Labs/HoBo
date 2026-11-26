# Simulation Fixtures

The simulation creates its runnable Snapshop fixture in the operating-system temp directory and deletes it after completion. This directory documents the fixture contract so tracked files do not contain generated scratch output.

Fixture contract:

- project name: `snapshop`
- template: `api`
- Camps: deterministic `dev`, `staging`, `prod`, and preview Camps from the POC harnesses
- external services: none
- credentials: in-memory SVID and token references only
