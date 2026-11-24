---
name: alchemy-domain
description: Build and test EffectTS + Alchemy v2 systems and @alchemy.run/domain BDD models (aggregates, commands, events, rejections, views, policies, sagas, projections, queries, external systems, Apis, and Story BDD tests) using @effect/tsgo and https://alchemy.run/llms.txt. Use when writing or changing Effect code, Alchemy IaC/resources, or @alchemy.run/domain models and Story tests.
---

# EffectTS + Alchemy v2 + Alchemy Domain BDD

Follow the repository rules in `AGENTS.md`: self-documenting code with zero explanatory comments, no planning or design documents, no stored secrets (`owner://<NAME>` only), and strictly impacted-only tests.

## 1. Documentation lookup (never guess URLs)

- **Alchemy v2 guides & concepts:** fetch `https://alchemy.run/llms.txt` first to locate the exact page URL before reading it.
- **Alchemy v2 per-resource API reference:** fetch `https://alchemy.run/llms-full.txt` only when you need a specific resource's API reference page (it is large).
- **Effect v4 reference:** read the version-matched docs shipped in `node_modules/effect/AGENTS.md` and `node_modules/effect/ai-docs/`.
- **Alchemy Domain package skill:** inspect `node_modules/@alchemy.run/domain/skills/alchemy-domain/` when present for version-matched building-block templates.

## 2. Effect Language Service (`@effect/tsgo`)

- `tsconfig.base.json` enables `@effect/language-service` via `@effect/tsgo`.
- After any Effect or Alchemy TypeScript edit, run impact-scoped `@effect/tsgo` diagnostics:
  - `pnpm run typecheck:effect -- --staged` (or `--packages=packages/ci,packages/stations`)
  - Or directly: `pnpm exec effect-tsgo tsc -p <pkg>/tsconfig.json --noEmit`
- Fix Effect v4 diagnostics directly:
  - Prefer `Schema.Finite` / `Schema.Int` over `Schema.Number` for domain numbers.
  - Use `Schema.TaggedStruct` instead of `Schema.Struct({ _tag: Schema.Literal(...) })`.
  - Brand `Schema.TaggedError` classes with `{ readonly brand: unique symbol }`.
  - Yield yieldable errors directly (`return yield* new MyError(...)`) instead of `yield* Effect.fail(new MyError(...))`.
  - Do not import local `make<Capability>` service constructors into runtime code (`anti-slop-effect/no-service-constructor-imports` enforces Layer composition).

## 3. Alchemy Domain BDD (`@alchemy.run/domain/Story`)

Use Alchemy beyond machine IaC: model stateful HoBo control planes (`CiFleet`, `CdRelease`, `BrokerControl`, `StationRouting`, and new bounded contexts) as pure `@alchemy.run/domain` models under `packages/<pkg>/src/domain/` and specify behavior with BDD stories before and alongside implementation.

### Building blocks

- **Event** (`Domain.Event`): past-tense business fact carrying computed outcomes (`balanceAfter`, `settledMicros`) so `evolve` never recomputes rules.
- **Command** (`Domain.Command`): `<Verb><Noun>` naming target id, input, emitted `events`, declared `rejects`, and optional `reply`.
- **Rejection** (`Domain.Rejection`): typed refusal carrying diagnostic evidence; never `throw`.
- **Aggregate** (`Domain.Aggregate`): single consistency boundary with pure `decide`, total `evolve`, and total `reply`. Never perform raw I/O inside `src/domain/`.
- **View** (`Domain.View`): keyed read model folding events (and security boundary via `validate`).
- **Policy** (`Domain.Policy`): idempotent reaction to events; starts sagas instead of awaiting them.
- **Saga** (`Domain.Saga`): durable multi-step workflow with `Activity.make` and compensations (`Workflow.addFinalizer` / rollback steps); compensations never refuse.
- **External System** (`Domain.ExternalSystem`): typed port declared in `src/domain/` and implemented by an adapter Layer outside `src/domain/`.
- **Model & Api** (`Domain.Model`, `Domain.Api`): bounded context composition and typed client surface.

### BDD Story specifications (`@alchemy.run/domain/Story`)

Every package declaring `Domain.Model(...)` MUST have:

1. Static verification: `expect(Domain.verify(Model)).toEqual([])`
2. Executable BDD stories via `Story.make(Model, { layer, stub })`:
   - `Story.given(ref, ...events)` seeds prior history without firing policies.
   - `Story.when(ref, command)` sends a command and runs all policies, sagas, and projections until settled.
   - `Story.then(ref, ...events)` asserts every committed event (use `Story.anyOrder(...)` / `Story.inOrder(...)` for concurrent writers; `Story` explores up to 256 concurrent interleavings automatically and fails if any event, rejection, or external call is unaccounted for).
   - `Story.rejected(...)`, `Story.replied(...)`, `Story.state(...)`, `Story.view(...)`, `Story.query(...)`.
   - `Story.call(op, match)` + `Story.succeed(op, value)` / `Story.fail(op, error)` / `Story.die(op, defect)` to verify external ports and failure/compensation branches.
   - `Story.clock(...)` and `Story.advance(...)` to test deadlines, leases, and cooldowns deterministically.
   - `Story.saga(Saga, ref, status)` and `Story.signal(...)` to assert workflow outcomes without coupling to internal steps.

### Hosting portability

Keep domain models pure and host them on any `Domain.Platform` Layer without changing domain code:
- `Domain.InMemory` for fast BDD stories and in-process API tests.
- `@hobo/storage-sqlite` (`createSqliteDomainPlatform`) for local-first durable SQLite execution.
- `@alchemy.run/domain/Cloudflare`, `@alchemy.run/domain/Rivet`, or `@alchemy.run/domain/EffectCluster` for distributed production hosting.

## 4. Verification checklist (impacted scope only)

1. `pnpm --filter <pkg> exec vitest run <story-test-file>`
2. `pnpm run lint:domain-boundaries` (verifies no raw I/O in `src/domain/`, no secret-shaped schema fields, `Domain.verify`, and `Story.make` BDD coverage)
3. `pnpm run typecheck:effect -- --packages=<pkg>`
4. `pnpm run lint:slop:changed -- --staged`
