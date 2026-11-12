# `@hobo/cd` data models

Protobuf first, CUE constraints beside it, parse-don't-validate in TypeScript
(AGENTS.md architecture rules).

| File | Role |
|---|---|
| `cd.proto` | Every `@hobo/cd` record and event body (`package hobo.cd.v1`). **Frozen** by plan 0024 Appendix A: only the coordinator amends it. Records reference each other by string id. |
| `buf.yaml` | `buf lint` configuration (DEFAULT rules). |
| `<module>.cue` | Constraints for the records one module owns (`freight.cue`, `sources.cue`, `artifacts.cue`, `sets.cue`, `pipelines.cue`, `windows.cue`, `promotion.cue`, `reconcile.cue`, `verification.cue`, `rollout.cue`, `inventory.cue`, `placement.cue`, `fanout.cue`, `failover.cue`, `posture.cue`). Each file is owned by the work package that owns the module. |

Generated TypeScript lives in `../src/_generated/` (`pnpm run codegen`); never
edit it by hand. Event names, stream ids, refusal codes and every numeric
default are in `../src/events.ts`, not here.

Each module parses wire JSON or protobuf into a derived type once, at its
boundary, and the CUE constraints are checked by `pnpm run test:schema`.

## Runbook

- **`codegen:check` fails after a proto amendment.** Run `pnpm run codegen` and
  commit `src/_generated/`. Only the coordinator amends `cd.proto`.
- **A `test:schema` failure names a `.cue` file.** A record no longer satisfies
  its constraint; fix the producer, not the constraint, unless the decision in
  [ADR-0180](../../../docs/design/adr/01-architecture-core.md#adr-0180) changed.
- **An old event body no longer decodes.** Every body has a golden upcaster
  corpus entry; add an upcaster in the owning module rather than editing the
  stored event.
