# Findings — pass 001

## Experiments applied
- **E-1** `run-relevant-checks.ts`: print `ok agent:check — N relevant check(s) passed` on success; clearer empty-scope message
- **E-2** staged mode can detect package.json scripts-only changes (was forced false for staged)

## Residual
- Friction 1 remains when many relevant gates run for mixed package.json + docs + skill staging — **expected impact-scoped cost**, not a bug
- Unstaged biome format on packages/ (working tree) vs intentional staged DX — **needs commit decision**, not a persona gate failure (lint:code is green when tree is formatted)

## Implementable S/M remaining for measured cells
**0** — no safe reduction that lowers metric_max without weakening gates or inventing a parallel check surface
