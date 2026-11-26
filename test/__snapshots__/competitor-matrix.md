
| Competitor | Canonical doc | Aliases | Primary category | All categories | Directness | Contested HoBo surfaces | Posture | HoBo evidence | Product status | Researched | Contract |
| ---------- | ------------- | ------- | ---------------- | -------------- | ---------- | ----------------------- | ------- | ------------- | -------------- | ---------- | -------- |
| **Acme** | [`acme.md`](acme.md) | — | `infrastructure-from-code` | `infrastructure-from-code` | direct | authoring | borrow | design-only | active | 2026-05-01 | v1 |
| **Legacy Corp** | [`legacy-corp.md`](legacy-corp.md) | oldname | `self-hosted-paas` | `self-hosted-paas` | adjacent | delivery | benchmark | not-present | renamed | 2025-01-15 | pre-v1 |
| **zebra systems** | [`zebra.md`](zebra.md) | zed, zebra.io | `runtime-substrates` | `runtime-substrates` · `infrastructure-from-code` | overlapping | runtime-portability, governance | provider-target, benchmark | implemented | active | 2026-05-20 | v1 |

### Freshness ledger

Captures are considered stale 180 days after their researched date. Staleness never fails the build — it schedules refresh work: `pnpm run docs:competitors` lists the stale captures on the day it runs.

| Competitor | Researched | State |
| ---------- | ---------- | ----- |
| [Legacy Corp](legacy-corp.md) | 2025-01-15 | pre-v1 — rewrite to contract |
| [Acme](acme.md) | 2026-05-01 | contract v1 |
| [zebra systems](zebra.md) | 2026-05-20 | contract v1 |

_3 canonical captures across 3 categories; 2 at contract v1._
