# @hobo/patterns

Canonical HoBo **pattern catalog**. SQLite/index files and VS Code snippets are
generated projections. Reference applications under `examples/` stay runnable
apps; they are not the catalog. Starters are pattern renderings. Transforms
are structural effects. Fixtures live beside patterns and prove parse/render
behavior only.

Zero LLM tokens on every search, render and apply. Receipts record
`llmCalls = 0`. See [ADR.md](./ADR.md).

## Terms

| Term | Meaning |
|---|---|
| Reference application | Full `examples/*` app / CI fixture |
| Pattern | Versioned semantic concept with renderings |
| Starter | Multi-file project rendering (`starter.cli.*`) |
| Rendering | Snippet, file, project, markdown, VS Code, or effects |
| Catalog | Parsed patterns + content digest; rendering reads share one manifest-path lookup per loaded catalog |
| Index | Generated retrieval projection |
| Fixture | Parse/render proof only. Starter Gherkin under `patterns/**/features/` is catalog data, not the repo behavior lane. |

## Commands

```sh
pnpm --filter @hobo/patterns test
pnpm --filter @hobo/patterns run eval
pnpm --filter @hobo/patterns run build:index
pnpm --filter @hobo/patterns run generate:vscode
```

Programmatic use goes through `loadPatternCatalog`, `searchPatterns`,
`renderPattern` and `applyPatternPlan`; `hobo new` reaches the CLI starters
through `renderCliStarterFiles`.

Zero-token means **0 LLM calls / input / output tokens**, not zero CPU. Vectors
are one ranking channel beside exact ID/alias/symbol and FTS5. Default search
is offline. Application writes only inside a caller-supplied isolation root;
promotion out of it is the caller's job (`promotionRef: "caller-promotes"`).

CLI starter bodies live under `patterns/starter/cli/<alias>/project/` and are
the only source for `hobo new -t todo|api|agent|fullstack`. CLI starter ignore files exclude the local codegen/build lock database, its
SQLite sidecars and interrupted staging trees so recovery state stays local.

Atomic snippets live in [`atoms/`](./atoms/README.md) and load with the rest of
the catalog. Chat emit uses the same trees.

## What the loaders refuse

- An atom's `meta.json` must be a JSON object. An array or a scalar is refused
  with `atom meta must be an object`, and a `files` entry that is not an object
  with `<id>: invalid file entry`. Only primitive strings count as strings: a
  boxed `String`, or an object that sets `Symbol.toStringTag` to `"String"`, is
  not an atom id.
- `planPatternApplication` and `applyPatternPlan` take params of any value
  type. A string, number or boolean is coerced with `String()`, as
  `parseApplicationRequest` does; anything else is refused with
  `param <name> must be a scalar`.
