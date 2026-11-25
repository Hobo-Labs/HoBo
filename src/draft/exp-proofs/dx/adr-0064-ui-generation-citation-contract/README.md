# ADR-0064 UI generation citation contract (HOBO-704)

Executable acceptance for **REM-037 / DRIFT-009**: the four cited design docs must align
app/UI generation with the ADR-0064 **keep list** (UX Designer, design.md, OpenUI, json-render,
mcp-apps, `ui-render` port) and must not cite ADR-0064 as removing UI generation.

## Targets

| Doc | Fix |
| --- | --- |
| `docs/design/architecture.md` | `@hobo/ui-render` is in scope |
| `docs/design/stage-6-production-hardening-acceptance.md` | Only marketplace monetization is out |
| `docs/design/worked-example.md` | UX Designer generates product UI |
| `docs/competitors/gap-analysis.md` | App/UI generation remains in scope |

## Run

```bash
pnpm --prefix src/draft/exp-proofs/dx/adr-0064-ui-generation-citation-contract test
```

Architecture-guard evidence: `ARCHITECTURE.md`, `architecture/*.proto`, `architecture/*.cue`,
`architecture/pacts/*.pact.json`.

## Testing

Run `pnpm --filter @hobo/draft-adr-0064-ui-generation-citation-contract test`
(Vitest). The citation check resolves the repo root six levels up from the test
directory (the package sits under `exp-proofs/dx/`) before scanning the four
REM-037 target docs.
