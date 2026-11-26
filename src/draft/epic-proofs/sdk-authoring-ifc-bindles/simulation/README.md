# SDK & Authoring Simulation

## Running the epic simulation

Command:

```bash
npm.cmd --prefix src/draft/epic-proofs/sdk-authoring-ifc-bindles run simulate
```

What this proves:

- The sample app author flow lowers to a deterministic manifest and generated type surface.
- Authoring guardrails fail closed before deploy or record portability debt.
- Hobo Code and non-TypeScript idiom work stay parity-bound to the shared SDK contract.

Mocked boundaries:

- SDK WIT collector: fixture facts.
- Manifest IR registry: deterministic hash fixture.
- Collection coverage and capability gates: decision fixtures.
- XAA auth registry: target auth manifest fixture.
- SDK codegen workspace: generated artifact fixture.
- Local runtime harness: replay fixture.
- Topology lowerer, Hobo Code parser, auth contract provider, secret resolver, and SDK parity provider: fixture responses.

Contracts:

- `src/draft/epic-proofs/sdk-authoring-ifc-bindles/contracts/pacts/*.pact.json`
