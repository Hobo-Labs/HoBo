# Reduction — 20260731-all-exp / iteration 001

## Experiments applied

| Id | Finding | Change | Result |
|---|---|---|---|
| E-1 | F-1 | `design-system-contract`: primaryCommand + implementations + steps README → `pnpm run design:lint`; discovery bindings promote design:lint high, demote docs:design-lint low; surfaces include design:lint | **improved** (exit 0 designmd contract; uncertainty 0) |
| E-2 | F-2 | `agent-tooling-setup/steps/README.md` primary binding → setup-agent-tools.sh --help | **improved** (docs match surface) |
| E-3 | F-3 | `narrow-local-validation/steps/discovery.json` demote gate:s1 to low | **improved** (no high-conf wrong surface) |

## Files touched

- `.optimizexp/features/design-system-contract/feature.json`
- `.optimizexp/features/design-system-contract/steps/README.md`
- `.optimizexp/features/design-system-contract/steps/implementations.ts`
- `.optimizexp/features/design-system-contract/steps/discovery.json`
- `.optimizexp/features/agent-tooling-setup/steps/README.md`
- `.optimizexp/features/agent-tooling-setup/evidence/...` (re-capture)
- `.optimizexp/features/narrow-local-validation/steps/discovery.json`
- `.optimizexp/features/public-site-first-impression/evidence/...` (re-capture)
- `.optimizexp/features/cli-help-and-doctor/evidence/...` (re-capture)

## Expected metric deltas

| Cell | Before max | After max |
|---|---:|---:|
| design-system / designer | 3 | 0 |
| agent-tooling README | 2 | 0 |
| narrow-local discovery | 2 | 0 |
| agent:check multi-gate residual | 1 | 1 (unchanged L) |

## Residual risk

- Regenerating features via discovery harness may re-promote keyword matches; demotion notes document intent.
- Multi-gate staged checks remain L-effort.

## result

**improved** for F-1/F-2/F-3; residual F-4 unchanged (L).
