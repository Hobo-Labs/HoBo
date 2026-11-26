# @hobo/manifest-request

The **request manifest**: one catalog offer, as capability selection sees it.

`SelectionCandidate` is the minimal structural view the selector gates and
ranks — a *projection* of a Resource Definition rather than the definition
itself, so `@hobo/cloud` widens what it already has instead of maintaining a
second catalog. This package owns the schema for that shape; the selection
algorithm stays in `@hobo/capability-profiles`, which re-exports these names so
no consumer import changes.

| Artifact | What it is |
|---|---|
| `data-models/selection_candidate.proto` | The wire message. Field numbers are stable. |
| `data-models/selection_candidate.cue` | The invariants protobuf cannot state: closed vocabularies, canonical ordering, uniqueness, optional-not-null. |
| `src/index.ts` | `parseSelectionCandidate` (parse, don't validate), the canonical record encoder/decoder. |
| `contracts/pacts/selection-candidate-catalog.pact.json` | Six interactions over the catalog boundary, executed by `test/pact.test.ts`. |

```ts
import { canonicalSelectionCandidateJson, parseSelectionCandidate } from "@hobo/manifest-request";

const candidate = parseSelectionCandidate(await response.json()); // throws SelectionCandidateError
const bytes = canonicalSelectionCandidateJson(candidate);          // what a digest is taken over
```

## The four decisions worth knowing

**Parsed, not validated.** `parseSelectionCandidate` takes `unknown` and
returns a branded `ParsedSelectionCandidate`, or throws a
`SelectionCandidateError` naming the field (`error.path`) and the branch
(`error.message`). `SelectionCandidate` itself stays structural and unbranded:
every provider package builds one as an object literal, and a brand on that
type would make those literals unassignable.

**Absent, `null` and `undefined` are three different claims.** Only absence is
admissible for `evidenceExpiresAtMs`, and it means "no trust evidence
recorded", which fails the evidence gate closed. `tsconfig.base.json` sets
`exactOptionalPropertyTypes`, which draws the same line in the type system; the
encoder omits the key rather than emitting a null, and the decoder refuses both
other spellings by name.

**Unknown fields are refused, not dropped.** A producer carrying a
selection-relevant fact this schema does not model would otherwise have it
silently deleted from every digest taken downstream — which is the failure
described under "What does not round-trip" below, arriving by a second route.

**Canonical form is a set of decisions.** Set-valued fields
(`runtimeModels`, `producesBindingProfiles`, `migrationProfiles`) sort by code
point — never `localeCompare`, so an audit trail does not depend on the host's
collation locale — and refuse duplicates. Structured-capability keys sort the
same way, and index-shaped keys are refused because JavaScript hoists them out
of that order. `implementsProfiles` is **not** sorted: selection returns the
first entry that satisfies a required profile, so its order is a fact about the
candidate. Two claims for the same profile are refused instead.

## Round-trip results

The corpus is repository data, read at test time rather than invented:
36 candidates expanded from `packages/capability-profiles/test/selection.cases.jsonl`,
plus the multi-element binding-profile sets and the claim vocabulary committed
in `packages/recipes/test/golden/*.json`, plus the two real provider rows the
PACT carries (`neon.claimable-postgres/v1` and
`cloudflare.temporary-hyperdrive/v1`, transcribed from their provider
packages — the widest row in the repository and the one that implements no
profile at all).

- **All 36 survive** `domain → record → JSON → record → domain`, byte-identical
  and digest-identical on the second encode, with no field lost and with
  absence preserved as absence.
- All 36 emitted records **vet clean** against the CUE schema:
  ```bash
  .tools/cue/v0.14.0/cue vet -d '#SelectionCandidateRecord' \
    packages/manifest-request/data-models/selection_candidate.cue <record>.json
  ```
- Canonicalisation is **not the identity** on set-valued fields: a candidate
  authored as `["binding.postgresql/v1", "binding.neon-serverless/v1"]`
  (`@hobo/provider-neon`) encodes sorted. That matches what the committed
  topology goldens already contain, so nothing downstream changes.

### What does not round-trip — in `@hobo/cloud`, not here

Two selection-relevant facts survive this package's encoding but are **lost by
`semanticsDigestInput`** (`packages/cloud/src/registry/resource-definition-vnext.ts`),
the projection folded into `profileCatalogHash`. Its doc comment claims
"Changing any of these changes the digest and therefore the signed resolution
receipt, which is what makes a winner flip attributable to a catalog change."
Measured against the built package on 2026-08-19, that claim does not hold:

1. **`secretCustodyAvailable` is not in the digest input.** It is a hard gate —
   `SECRET_CUSTODY_UNAVAILABLE`, evaluated second, before every profile check —
   so flipping it turns a winner into a rejection while the catalog digest, and
   therefore the signed receipt, is unchanged. (`supportsRotation` and
   `supportsRevocation` are also absent, but no gate or ranking key reads them,
   so their absence is consistent.)
2. **`implementsProfiles` is sorted by profile id in the digest input, and
   selection reads it by position.** With a `data.relational/v1` requirement and
   pack realization denied, a candidate claiming
   `[data.postgres/v1 native, data.relational/v1 pack]` wins, and the same two
   claims in the other order are `REALIZATION_DENIED` — from a byte-identical
   digest input.

This package refuses both losses: `secret_custody_available` is field 21 of the
record, and reordering `implementsProfiles` changes the canonical bytes. Fixing
`@hobo/cloud` is out of this package's ownership and is reported as a finding.

## Where this sits in the control plane

A candidate is catalog data carried in the body of a **command**, never the body
of an event. A `hobo plan` command hands the Planner **actor** a catalog
snapshot of these rows; the actor selects over them and appends the resulting
`match.Decided` and `deployment.Planned` **events** to the **event store**. The
deployment **projection** and the plan **read store** are **materialized views**
folded from those events, and a **snapshot** of the projection is what a later
reader loads instead of replaying the stream.

What ties this package to any of that is the digest. `profileCatalogHash` folds
the catalog into the signed resolution receipt, which is why the canonical bytes
above are a contract and not a formatting choice. Nothing here writes to a
stream, owns an actor, or holds state: a manifest package owns a shape and its
parse boundary, and nothing else.

## Vocabularies restated, not imported

`BINDLE_RUNTIMES` and `REALIZATION_KINDS` are declared here as well as in
`@hobo/capability-profiles`. A manifest package's only workspace dependency is
`@hobo/core`, and `@hobo/core` does not carry them. `test/schema-parity.test.ts`
reads the other package's source as text and fails when either list — or the
`SelectionCandidate` field set, or the closed vocabularies, or the fixture
harness's base candidate — drifts from what this schema models. The duplication
is checked rather than trusted.
