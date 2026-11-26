# OptimizeXP features

Each **feature is a directory**:

```text
<feature-slug>/
  feature.json
  README.md
  *.feature          # one or more Gherkin files (same feature)
  steps/             # optional harness hooks
  evidence/
    <scenario-slug>/ # exactly one current primary.* per scenario
```

Personas live in `../personas/`. Tag scenarios with `@persona:<id>`.

Harness: `.agents/skills/optimizexp/harness/capture-evidence.mts`
