---
name: draft
description: Use when creating, moving, reviewing, or planning HoBo draft proof material under src/draft. Routes work across technical proofs, experience proofs, epic proofs, and project MVP rollups with progressive-disclosure references.
---

# Draft

The repository-wide rules at the start of `AGENTS.md` override this skill and its references: implement unfinished work, use self-documenting code, and do not create planning or design documents.

Use this skill for HoBo draft proof work. Drafts iterate, roll up, and refine requirements;
real implementations land under `packages/` via lift-and-leave promotion (never grown in place
from a draft). The old one-level draft layout is obsolete. All draft work belongs under one
taxonomy path:

- `src/draft/technical-proofs/<slug>`
- `src/draft/exp-proofs/<type>/<slug>`
- `src/draft/epic-proofs/<slug>`
- `src/draft/projects/<slug>`

## First moves

1. Read `src/draft/README.md` and the relevant reference below.
2. Classify the work by the smallest proof layer that can answer the question.
3. Keep proofs isolated. Mock or simulate every dependency outside the proof's atomic unit.
4. Use `git mv` for any existing draft package move or rename.
5. Express decisions in the implementation and executable checks.
6. Run the narrowest package gate first, then repo gates required by changed files.

## Reference routing

- Atomic technical concept: read `references/technical-proofs/process.md`.
- UX, DX, CX, API, SDK, or other human/interface experience: read `references/exp-proofs/process.md`.
- Epic-level rollup of technical and experience proofs: read `references/epic-proofs/process.md`.
- Project MVP rollup across epics: read `references/projects/process.md`.

## Guardrails

- Never add live cloud, provider, identity, billing, or support dependencies to default proof tests.
- Prefer protobuf, CUE, Pact, type tests, and deterministic fixtures over prose-only proof.
- Implementation record types come from generated proto code: opt into codegen with `data-models/buf.yaml`, import from `src/_generated/**_pb.ts`, never hand-declare parallel interfaces; avoid exported string-literal constants (schema ids/enums live in the proto) — see `docs/design/technical-standards.md`.
- Every new proof carries a `proof.json` manifest, gate-executed `examples/`, and an executed `notebook.ipynb` (tslab); scaffold from `src/draft/_templates/<layer>/`. Waivers require an ADR and live in `proof.json`.
- For technical proofs, performance is measured with `bench/*.bench.ts` (executable; numbers advisory) or explicitly waived in the ADR; add a mermaid architecture diagram where relevant.
- For experience proofs, model the audience and measurable friction first, then ship the per-type artifacts (`ux` real visuals · `dx` pseudo-code+proto+CUE+diagrams · `cx` journeys · `ax` MCP transcripts/tool schemas · `api` type tests+consumers).
- For epic proofs, the Gherkin suite is executable (`features/` + steps, `pnpm run test:behavior`) — true for ALL epics since the W2 backfill, not just new ones — and the notebook demonstrates the simulation.
- For epic and project rollups, propagate compatibility changes downward with ADRs; the inverse cascade is machine-enforced by `pnpm run draft:cascade` (changed leaf proofs must update referencing rollups in the same diff).
- The gates (`draft:artifacts`, `draft:cascade`) run automatically via `agent:check`; grandfathered packages (`src/draft/_grandfathered.json`) get advisories until their backfill wave lands.
