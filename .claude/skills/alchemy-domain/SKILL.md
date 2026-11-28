---
name: alchemy-domain
description: Build and test EffectTS + Alchemy v2 systems and @alchemy.run/domain BDD models (aggregates, commands, events, rejections, views, policies, sagas, projections, queries, external systems, Apis, Rivet Durable Objects/actors, and Story BDD tests) using @effect/tsgo, https://alchemy.run/llms.txt, and https://rivet.dev/actors/docs/testing/. Use when writing or changing Effect code, Alchemy IaC/resources, Rivet actors, or @alchemy.run/domain models and Story tests.
---

# EffectTS + Alchemy v2 + Alchemy Domain BDD + Rivet

Follow the repository rules in `AGENTS.md`: self-documenting code with zero explanatory comments, no planning or design documents, no stored secrets (`owner://<NAME>` only), and strictly impacted-only tests.

## 1. Documentation lookup (never guess URLs)

- **Alchemy v2 guides & concepts:** fetch `https://alchemy.run/llms.txt` first to locate the exact page URL before reading it (including `testing-models`, `testing-apis`, `rivet`, and `testing`).
- **Alchemy v2 per-resource API reference:** fetch `https://alchemy.run/llms-full.txt` only when you need a specific resource's API reference page (it is large).
- **Effect v4 reference:** read the version-matched docs shipped in `node_modules/effect/AGENTS.md` and `node_modules/effect/ai-docs/`.
- **Alchemy Domain package skill:** inspect `node_modules/@alchemy.run/domain/skills/alchemy-domain/` when present for version-matched building-block templates.
- **Rivet Actors testing:** consult `https://rivet.dev/actors/docs/testing/` for `rivetkit/test` (`setupTest`), SQLite persistence, event subscriptions, and scheduled callback polling.

## 2. Effect Language Service (`@effect/tsgo`) & Static Invariants

- `tsconfig.base.json` enables `@effect/language-service` via `@effect/tsgo`.
- After any Effect or Alchemy TypeScript edit, run impact-scoped `@effect/tsgo` diagnostics:
  - `pnpm run typecheck:effect -- --staged` (or `--packages=ci,cd,stations`)
  - Or directly: `pnpm exec effect-tsgo tsc -p <pkg>/tsconfig.json --noEmit`
- Make invalid states unrepresentable at compile time and schema decode boundaries:
  - Brand every domain identifier, digest, reason, and bounded numeric invariant (`Schema.NonEmptyString`, `Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))`, `Schema.isPattern(...)`, `Schema.NonEmptyArray(...)` with uniqueness filters) instead of clamping with `Math.max` inside `decide`.
  - Model every stateful aggregate AND view as a discriminated union of `Schema.TaggedStruct(...)` variants — avoid flat nullable field bags.
  - Brand `Schema.TaggedError` classes with `{ readonly brand: unique symbol }`.
  - Yield yieldable errors directly (`return yield* new MyError(...)`) instead of `yield* Effect.fail(new MyError(...))`.
  - Add a package-local `tsconfig.domain-tests.json` wired into `package.json` `typecheck` so compile-time `@ts-expect-error` negative proofs are verified on every build.
  - Do not import local `make<Capability>` service constructors into runtime code (`anti-slop-effect/no-service-constructor-imports` enforces Layer composition across `src/domain/**` and `src/host/**`).

## 3. Alchemy Domain BDD (`@alchemy.run/domain/Story`)

Model stateful HoBo control planes (`CiFleet`, `CdRelease`, `StationRouting`, `DispatchRouting`, `BackendRouting`, `BrokerControl`, and new bounded contexts) as pure `@alchemy.run/domain` models under `packages/<pkg>/src/domain/` and specify behavior with BDD stories before and alongside implementation.

### Building blocks

- **Event** (`Domain.Event`): past-tense business fact carrying computed outcomes (`balanceAfter`, `settledMicros`) so `evolve` never recomputes rules.
- **Command** (`Domain.Command`): `<Verb><Noun>` naming target id, input, emitted `events`, declared `rejects`, and optional `reply`.
- **Rejection** (`Domain.Rejection`): typed refusal carrying diagnostic evidence; never `throw`.
- **Aggregate** (`Domain.Aggregate`): single consistency boundary with pure `decide`, total `evolve`, and total `reply`. Never perform raw I/O inside `src/domain/`.
- **View** (`Domain.View`): keyed read model folding events into a discriminated tagged-union state (and security boundary via `validate`).
- **Policy** (`Domain.Policy`): idempotent reaction to events; starts sagas instead of awaiting them.
- **Saga** (`Domain.Saga`): durable multi-step workflow with `Activity.make` and fail-closed compensations (`Effect.result` on rollback/compensation activities — never swallow rollback errors with `Effect.ignore`).
- **External System** (`Domain.ExternalSystem`): typed port declared in `src/domain/` and implemented by an adapter Layer outside `src/domain/`.
- **Model & Api** (`Domain.Model`, `Domain.Api`): bounded context composition and typed client surface.

### Testing models, adapters, APIs, and Rivet hosts (current guidance)

Every package declaring `Domain.Model(...)` and a `src/host/` layer MUST cover:

1. **Static model verification:** `expect(Domain.verify(Model)).toEqual([])` plus compile-time `@ts-expect-error` negative proofs verified via `tsconfig.domain-tests.json`.
2. **Executable BDD stories (`Story.make(Model, { layer, stub })`):**
   - `Story.given(ref, ...events)` seeds prior history without firing policies.
   - `Story.when(ref, command)` sends a command and runs all policies, sagas, and projections until settled.
   - `Story.then(ref, ...events)`, `Story.rejected(...)`, `Story.replied(...)`, `Story.state(...)`, `Story.view(...)`, `Story.query(...)`.
   - `Story.call(op, match)` + `Story.succeed(op, value)` / `Story.fail(op, error)` / `Story.die(op, defect)` to verify external ports and fail-closed rollback/compensation branches.
   - `Story.clock(...)` and `Story.advance(...)` to test deadlines, leases, and cooldowns deterministically.
   - `Story.saga(Saga, ref, status)` and `Story.signal(...)` to assert workflow outcomes without coupling to internal steps.
3. **ExternalSystem adapter conformance (`https://alchemy.run/domain/testing-models`):**
   - Run one shared contract test suite against every `ExternalSystem.toLayer` implementation (stateless stubs, stateful doubles, live adapters).
   - Prove schema drift at the adapter boundary fails closed with `ExternalSystemSchemaError`.
4. **API in-process & real HTTP round-trip (`https://alchemy.run/domain/testing-apis`):**
   - Test `Api.clientInProcess` inside `Effect.scoped` with a fresh `Domain.InMemory` layer.
   - Test over real HTTP using `NodeHttpServer.layerTest` + `HttpServer.serve()(api.fetch)` + `Domain.protocolHttp("")` + `Api.client` (the same HTTP protocol used by `@alchemy.run/domain/Rivet`).
   - Test restart durability against `@hobo/storage-sqlite` (`createSqliteDomainPlatform` + `createNodeSqliteDriver({ path })`).
5. **Rivet hosting & RivetKit actor tests (`https://alchemy.run/domain/rivet`, `https://rivet.dev/actors/docs/testing/`):**
   - Keep Rivet composition in `packages/<pkg>/src/host/` (exported as `./host`) with `@alchemy.run/rivet` and `rivetkit` as optional `peerDependencies` + `devDependencies` (never `dependencies` on publishable packages, preserving license hygiene and lean installs).
   - Compose `Model.layer(Handlers)` over `DomainRivet.layerDurableObjects({ name, main, handler, pool })` alongside `Domain.InMemory` and `createSqliteDomainPlatform`.
   - Test RivetKit SQLite actors using official `setupTest(testCtx, registry)` from `rivetkit/test` against an ephemeral loopback Rivet engine (`@rivetkit/engine-cli`, pinned with `/usr/bin/taskset -c 0` on Linux to avoid virtualized multi-core `CLOCK_BOOTTIME` monotonic jitter).
   - Call actions on the open connection (`conn`) before asserting `conn.on(...)` broadcasts with `vi.waitFor`.
   - Verify scheduled callbacks (`c.schedule.after`) with bounded `expect.poll(..., { timeout, interval })` — never `vi.useFakeTimers()`, because RivetKit's scheduler runs outside Vitest's JS timer queue.
   - Add `server: { deps: { inline: [/@alchemy\.run\//, /\/alchemy\//] } }` in package `vitest.config.ts` so Vite transforms `.ts` files shipped under `alchemy` and `@alchemy.run/*`.

## 4. Verification checklist (impacted scope only)

1. `pnpm --filter <pkg> run typecheck` (includes `tsconfig.domain-tests.json`)
2. `pnpm --filter <pkg> exec vitest run <domain-and-host-tests>`
3. `pnpm run lint:domain-boundaries` (verifies no raw I/O in `src/domain/`, no secret-shaped schema fields, `Domain.verify`, and `Story.make` BDD coverage)
4. `pnpm run typecheck:effect -- --packages=<pkg>`
5. `pnpm run lint:slop:changed -- --staged`
