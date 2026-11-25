# POC Rollup Ledger

| POC | Source | Related Linear | Persona | BDD scenario | Vertical slice | Service boundaries | Pact contracts | Reference impl status | Disposition | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| Dashboard projection views | `src/draft/exp-proofs/ux/full-dashboard-projection-views-contract` | HOBO-662 | Release engineer | Stage-6 dashboard audits pass WCAG 2.1 AA and pseudo-localization checks. | Stage-6 acceptance drill | DashboardA11yAudit | pact-dashboard-a11y-audit | verified | implemented_in_reference_impl | The leaf identity example removed an unnecessary type assertion; the dashboard contract and fixture remain unchanged. |

## Cascade absorption

The referenced UX proof changed only its example boundary typing. The Stage-6
rollup absorbs that change by retaining the existing dashboard Pact, fixture,
negative scenario, and executable acceptance feature as the integration
evidence.

The referenced `s6-09-operator-crew-yard-services-contract` leaf likewise
only restored the nullish defaults the anti-slop sweep stripped, which had left the leaf crashing on omitted optional fields (principal and signal parsing). No
Stage-6 scenario, gate, or evidence path moves.
