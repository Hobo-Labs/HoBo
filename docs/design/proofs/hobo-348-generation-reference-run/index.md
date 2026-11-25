# HOBO-348 Generation Reference Run Proof

This branch proves the end-to-end cold-start generation reference run as an
independent draft contract:
[`src/draft/technical-proofs/generation-reference-run-contract`](../../../../src/draft/technical-proofs/generation-reference-run-contract).

## Acceptance Mapping

| Issue requirement | Executable proof |
|---|---|
| Reference run certifies a `database` provider end-to-end | `cold-start database provider run composes scaffold, fill, validation, repair, and certification` asserts the scaffold -> fill -> repair -> certify stage sequence, green validation, local+Camp coverage, signed certification, and `gen.Certified`/`gen.PluginCertified` events. |
| Repair loop converges or escalates | `bounded non-convergence emits one NeedsHuman event and never certifies` exhausts the two-attempt budget and proves no Registry certification is emitted. |
| Certification carries complete provenance | The happy-path test asserts the certification payload binds the final artifact digest, validation report ref, model, prompt, seed, and signed provenance. |
| Cold-start docs/OpenAPI path certifies or escalates through sandbox + conformance | `docs-only cold-start path either certifies through conformance or escalates without bypass` proves docs-only material remains untrusted and cannot bypass validation. |
| Wrong synthesis cannot certify | `wrong synthesis guesses and contradictory material cannot certify a different port` keeps a cache/Redis guess failing until `gen.NeedsHuman`, with no certification. |
| Pinned inputs reproduce the result | `pinned inputs reproduce artifact and certification payload digests` proves stable candidate and certification digests for unchanged model/prompt/seed/material inputs. |

## Scope Boundaries

The POC does not implement a production generator, model provider, real Camp,
cloud database adapter, Firecracker runner, or Registry backend. It composes the
existing draft stage contracts and uses fixture evidence to make the acceptance
boundary executable on a branch.
