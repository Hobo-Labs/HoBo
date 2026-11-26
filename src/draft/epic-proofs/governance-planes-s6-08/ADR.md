# Governance Planes S6-08 — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`.

## Schema and constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, don't validate

Untrusted input is parsed once at each seam into **parsed derived types** and
**derived domain types**. Downstream evaluators receive parsed notify requests,
placement contexts, guardrail runs, and certified listing events — applying
**parse, don't validate** at the boundary.

## Event architecture

The owning **actor** consumes **commands**, appends **events** to the **event store**,
and folds **materialized views** / **projections** for query surfaces. **Snapshots**
cache current read state; downstream **read stores** query projections rather than
the raw log.

| Flow | Command | Actor | Event store | Projection / materialized view | Snapshot | Read store |
|---|---|---|---|---|---|---|
| Notify | `notify.send` | notify dispatcher | append-only notify stream | delivery audit trail | latest delivery state | audit explorer |
| Residency | `hobo:deployment:can-deploy` | planner gatekeeper | policy decision log | placement gate view | current deployability | plan review UI |
| Erasure | `hobo erase --subject` | erasure saga actor | erasure stream | customers excluding erased subjects | projection digest | dashboard data views |
| Guardrail | `ai.output.guardrail` | guardrail step actor | guardrail run stream | withheld output state | buffered window watermark | agent activity view |
| Registry install | `match.resolve` | matching engine | match + install events | certified listing index | discovery snapshot | registry browser |

No runtime engine is implemented here; this package names the command, event,
actor, and projection boundaries for Stage-6 productionization.
