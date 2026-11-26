# Pass 1 reductions — 20260731-ax-cli-wire

## E-1: rewire cli-help-and-doctor to offline doctor
- Files: feature.json, implementations.ts, discovery.json, evidence
- Result: **improved** — bindings 4/4; no live path

## E-2: doctor warn on stdout
- Files: scripts/doctor.ts
- Result: **improved**

## E-3: vitest guard for agent-tooling doctor lines
- Files: test/doctor-agent-tooling.test.ts
- Result: **improved** — test passes
