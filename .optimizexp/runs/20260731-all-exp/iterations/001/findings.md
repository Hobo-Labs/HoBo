# Findings — 20260731-all-exp / iteration 001

## Ranked (leverage = impact on metric_max / effort)

### F-1: design-system-contract primary was docs:design-lint
- Metrics (judged pre-reduce): friction=2, uncertainty=3
- Personas: product-designer, product-app-developer, product-coding-agent
- Evidence: design-system-contract discovery + feature.json prior state
- Smallest reduction: rewire `primaryCommand` / implementations / README / discovery to `pnpm run design:lint` (DESIGN.md/designmd); demote `docs:design-lint`
- Effort: **S**

### F-2: agent-tooling-setup steps README stale primary
- Metrics: friction=1, uncertainty=2
- Personas: product-coding-agent, product-agent-operator
- Evidence: steps/README claimed skills:mirror-check; feature.json already setup --help
- Smallest reduction: align README to `bash scripts/setup-agent-tools.sh --help`
- Effort: **S**

### F-3: narrow-local-validation discovery ranked gate:s1 high
- Metrics: uncertainty=2
- Personas: product-app-developer
- Evidence: discovery.json gate:s1 confidence high
- Smallest reduction: demote gate:s1 confidence low + reason not narrow-local
- Effort: **S**

### F-4 (residual L): multi-gate agent:check wait
- Metrics: friction=1
- Personas: junior-typescript-developer, product-app-developer
- Evidence: prior 20260731-dx-plateau residual
- Smallest reduction: impact-policy redesign for concurrent multi-scope staged checks — **L**, not this cycle
- Effort: **L** (not implementable S/M)

## Implemented this iteration

- F-1, F-2, F-3 applied (see reduction.md)
- Discovery re-aligned: all 7 features discovery[0] matches primaryCommand
- Evidence re-captured for design-system, public-site, agent-tooling, doctor

## implementableFindingsRemaining

After reduce: **0** (F-4 is L/external policy residual only)
