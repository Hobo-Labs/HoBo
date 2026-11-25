# ADR — Convex Swaghaus Bindle DX

## Context

Author Bindles with `@hobo/convex` markers; never pin Convex provider on the
Bindle. WorkOS rides `b.external` + Camp secrets.

The first version of this proof only asserted that the annotation existed. That
left the authoring surface with no boundary: a manifest carrying a provider pin,
a pasted deploy token, or a web Kit with no backend dependency would sail
through authoring and only fail later as a plan rejection — the worst place for
a developer to learn about it.

## Decision

1. Treat the **serialized Bindle manifest graph** as the untrusted input of the
   experience, because that is what Matching receives. `src/parse.ts` is the one
   parser boundary; `parseSwaghausBindle` returns the parsed derived type
   `SwaghausBindlePlan` over branded `ConvexAppRoot` / `ResourceName` /
   `EnvName` values, and `src/authoring.ts` (draft → serialize → parse) accepts
   only that plan.
2. Move refusals to the authoring boundary with a remediation sentence:
   provider pins (ADR-0024/ADR-0144), plaintext secret material in annotation
   config (ADR-0027), a missing or duplicated web Kit, a web Kit without the
   `convexApp(root)` marker or without both its data and external dependencies,
   a web root escaping the repo, and env names with no declared routing.
3. Give every required env name an explicit Bindle routing derived from
   `ENV_TO_BINDLE_KIND` — WorkOS names to `external`, `VITE_CONVEX_URL` to the
   realized `data` output, the deploy key to a broker/Camp value — instead of
   defaulting unknown names to plain env vars.
4. Constrain every protobuf type in `architecture/bindle.proto` with
   `architecture/bindle.cue` (formats, required topology, routing rules,
   uniqueness, authoring-phase transitions), and cover `ProofRoot` in
   `data-models/proof.cue`. The CUE and the parser are a matched pair.
5. Document the event architecture the authored manifest feeds without
   inventing any of it: the real `@hobo/cloud` families (`deployment.*`,
   `match.*`), the Planner/Orchestrator and `ResourceActor`, and the
   projections that publish the resolved topology. A test re-reads
   `packages/cloud/src/events.ts` and fails if the README names a fact that
   catalog does not export.

## Consequences

- Authoring mistakes now fail fast, in the author's own terms, with the Camp /
  `b.external()` remediation attached.
- The proof reuses the real `resolveConvexRoot` containment guard when a repo
  root is known, so the parsed root satisfies the same rule `@hobo/convex`
  applies at resolve time.
- As draft proof material this package needs no production `contracts/` folder;
  its protobuf/CUE pair lives under `architecture/`, with the example-tree
  constraint in `data-models/`.

## Cascade

No epic proof or project rollup references this proof
(`src/draft/epic-proofs`, `src/draft/projects`), so this change cascades
nowhere; `pnpm run draft:cascade` is the mechanical check. A rollup that starts
consuming `SwaghausBindlePlan` must absorb the refined type — ledger row and
simulation — in the same diff.
