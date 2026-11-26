# OptimizeXP all-exp equilibrium — 20260731-all-eq

## Scope

| Field | Value |
|---|---|
| Experiences | **ux + dx + ax** (bare) |
| Passes | **infinite** → **pareto-equilibrium** |
| Auto-init | skipped |
| Personas (survey) | product-app-developer, product-coding-agent, product-designer, product-end-user |
| Features | all 7 |

## Regimes

| Regime | Outcome |
|---|---|
| harm_reduce | Floor immediately: metric_total=0, metric_max=0 (all primaries exit 0) |
| delight_maximize | Uplifts E-1..E-3; survey + backlog; residual L only |

## Scores

### Harm

| | metric_total | metric_max |
|---|---:|---:|
| Baseline / floor | **0** | **0** |
| After delight | **0** | **0** (no regression) |

### Delight (survey)

| Persona | excitement | ease | optimal | gapMax |
|---|---:|---:|---:|---:|
| product-app-developer | 3 | 5 | 4 | 2 |
| product-coding-agent | 4 | 5 | 4 | 1 |
| product-designer | 4 | 5 | 4 | 1 |
| product-end-user | 3 | 4 | 3 | 2 |

Aggregate: delight_min=**3**, gap_max=**2**, delight_total=**48**

## Experiments

| Id | Change | Result |
|---|---|---|
| E-1 | `doctor` gbrain warn → copy-paste zero-key next step + AUTH | done (S) |
| E-2 | All `product-*` personas → schema v2 (segment/demo/psycho/cognitive) | done (M) |
| E-3 | design:lint primary path confirmed | done (S) |

## Stop

**`pareto-equilibrium`**

- implementableHarmRemaining = 0  
- implementableUpliftRemaining = 0 (S/M)  
- harm flat at 0; no cognitive breaches  
- Residual L only: multi-gate agent:check progress; optional web capture for site IA  

## Survey + backlog

- `runs/20260731-all-eq/survey/` (4 personas)  
- `runs/20260731-all-eq/backlog.json`  
- Global: `.optimizexp/backlog/experiments.json`  

## Evidence

- doctor / design:lint / setup --help / docs:site-nav re-captured under feature evidence/  

## Residual (next owners)

| Item | Effort |
|---|---|
| Multi-gate agent:check ordered progress | L |
| Optional Playwright first-impression capture | L |
