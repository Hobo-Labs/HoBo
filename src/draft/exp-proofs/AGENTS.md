# Experience proof instructions

Follow `src/draft/AGENTS.md` and the repository-wide rules. Implement the requested experience and exercise its observable behavior. Do not create design documents, planning documents, synthetic personas, or placeholder scenarios.

Experience packages live under `src/draft/exp-proofs/<type>/<slug>`:

| Type | Audience | Evidence checked by the artifact gate |
|---|---|---|
| `dx` | Developers and operators | Protobuf and CUE contracts |
| `ux` | End users | Visual assets |
| `cx` | Customers and publishers | Executable tests or feature steps |
| `ax` | Agents | MCP transcripts or tool-schema fixtures |
| `api` | API and SDK consumers | Type tests |

Keep `proof.json` aligned with the type folder. Run the package tests, runnable examples, required notebook checks, and relevant staged artifact and cascade gates. Update and test affected referencing packages when behavior changes.
