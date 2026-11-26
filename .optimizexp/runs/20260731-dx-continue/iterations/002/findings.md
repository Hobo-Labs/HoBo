# Findings — iteration 002

## Experiments applied (all landed)
- **E-4** konsistent: exclude `packages/adapters` container; nest `packages/adapters/{name}`
- **E-5** cli-spec: add `trails`; remove lifecycle deploy from retired (CD deploy stays); fix table pipes; fix docs mentions
- **E-6** check-cli-docs extractIssues accepts ADR-*; tests updated
- **E-7** design index ADR-0131 → architecture-core
- **E-8** traceability rows ADR-0129–0138
- **E-9** biome format write (245 files) so lint:code can pass when selected

## Residual
- Unstaged package format drift vs git index if not committed with E-9 (working tree formatted)
- Gate count for package.json-touching staged sets is still broad (friction 1, expected)
- No further S/M implementable reductions for measured cells
