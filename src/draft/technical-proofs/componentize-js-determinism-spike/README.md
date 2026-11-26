# HOBO-603 — componentize-js determinism spike

Independent spike deciding whether `@bytecodealliance/componentize-js@0.21.0` can meet
HOBO-584's byte-identical double-build acceptance, and what S0 stage gate replaces it if not.

## Root cause

`componentize-js` embeds StarlingMonkey (SpiderMonkey) and uses a **Wizer snapshot** of the JS
engine runtime to produce the final wasm component. That snapshot path is **not byte-stable**
across clean builds even when:

- `SOURCE_DATE_EPOCH` is pinned
- source files are sorted and path-remapped to `/workspace/<name>`
- `disableFeatures: ["random", "clocks", "stdio", "http"]` is set
- `jco@1.24.3` and `componentize-js@0.21.0` are exact-pinned

Evidence on this branch (three consecutive `buildHelloBindle()` calls):

| Build | Component digest | Bytes |
| --- | --- | --- |
| 1 | varies per run | ~12.4 MB |
| 2 | varies per run | ~12.4 MB |
| 3 | varies per run | ~12.4 MB |

`inputsDigest` and jco smoke output (`hello-bindle:ok`) remain stable.

Upstream: [bytecodealliance/ComponentizeJS#321](https://github.com/bytecodealliance/ComponentizeJS/issues/321)
(open; same symptom — stable JS bundle, unstable wasm sha256).

Post-process options investigated in scope:

| Option | Result |
| --- | --- |
| Additional `disableFeatures` | Already minimal for hello-bindle fixture |
| `debugBuild` / cache flags | No documented byte-stability guarantee in 0.21.0 API |
| `wasm-tools strip` / canonicalize | Deferred to signing slice — not an S0 build-path requirement |

## Decision (ADR-0105)

**Relax S0 byte-identical wasm acceptance.** Stage gate for `@hobo/componentize` (HOBO-584) becomes:

1. **Stable `inputsDigest`** — canonical spec + sorted source digests + toolchain pins
2. **Smoke equivalence** — jco transpile + `health` export returns `hello-bindle:ok`
3. **OCI manifest determinism** — manifest JSON canonicalized from deterministic inputs (not from wasm bytes)
4. **`wasm-tools validate`** — component-model validity in scoped CI (pinned `wasm-tools@1.235.0`)

**Deferred:** byte-identical wasm double-build and digest-equality signing gates move to the
artifact signing / provenance slice (HOBO-7 / HOBO-587) once upstream reproducibility or
`wasm-tools` canonicalization is available.

Trade-off is explicit in [ADR-0105](../../../../docs/design/adr/01-architecture-core.md#adr-0105);
this spike does **not** silently accept nondeterminism.

## Repro command

```bash
pnpm --prefix src/draft/technical-proofs/componentize-js-determinism-spike repro
```

Or the full spike test suite:

```bash
pnpm --prefix src/draft/technical-proofs/componentize-js-determinism-spike test
```

Build helper: `src/build.ts` in this package (self-contained; mirrors HOBO-584 draft controls).

When the HOBO-584 draft POC is on the branch, you can also compare against
`src/draft/technical-proofs/hobo-componentize/scripts/double-build-check.mts`.

## Acceptance mapping (HOBO-603)

- Root cause documented with repro command (this README + `scripts/repro-nondeterminism.mts`)
- Decision recorded: relax acceptance with rationale ([ADR-0105](../../../../docs/design/adr/01-architecture-core.md#adr-0105))
- HOBO-584 acceptance bullets updated via Plan 20 + proof index cross-links

## References

- [HOBO-584](https://linear.app/quickdeploy-ai/issue/HOBO-584) parent slice
- [ADR-0085](../../../../docs/design/adr/01-architecture-core.md#adr-0085) toolchain pins
- [Plan 20](../../../../docs/design/wasm-runtime-wit.md#plan-20) componentize stage gate
