---
type: Design Proof
title: "HOBO-704 — ADR-0064 UI generation citation remediation"
description: "Pins REM-037 acceptance: four design docs must not mis-cite app/UI generation as out of scope versus ADR-0064's keep list."
tags: [hobo, intent-alignment, adr-0064, scope]
---

# HOBO-704 — ADR-0064 UI generation citation remediation

Linear: [HOBO-704](https://linear.app/quickdeploy-ai/issue/HOBO-704)

## Proves

- `docs/design/architecture.md` maps `@hobo/ui-render` as in-scope app/UI generation.
- `docs/design/stage-6-production-hardening-acceptance.md` scopes out marketplace monetization only.
- `docs/design/worked-example.md` credits the UX Designer for product UI generation.
- `docs/competitors/gap-analysis.md` records app/UI generation in the ADR-0064 keep list.

## Contract

[`adr-0064-ui-generation-citation-contract`](../../../../src/draft/exp-proofs/dx/adr-0064-ui-generation-citation-contract/README.md)

```bash
pnpm --prefix src/draft/exp-proofs/dx/adr-0064-ui-generation-citation-contract test
```
