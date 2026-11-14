# Contracts

## `provider-local-catalog.pact.json`

The one boundary out of this package is in-process: a composition root
(the first-party catalog in `@hobo/hobo`) reads the definitions this
package publishes. The pact's paths name those catalog reads; they are not
HTTP endpoints, and this package makes no network calls of its own.

`@hobo/provider-local` is the provider. This pact is a **provider-side
shape pin**, not consumer-verified: there is no consumer-generated
contract. Consumer verification is the `@hobo/hobo` first-party catalog test
(`packages/hobo/test/first-party-catalog.test.ts`, "local yard definitions"),
which reads the definitions through the real catalog and selection.
`test/contract.test.ts` replays every interaction by computing
the response from the real exports (`LOCAL_DEFINITIONS`,
`LOCAL_ENGINE_GAPS`) and comparing it with the recorded body, so what this
package publishes cannot drift from what the pact promises.

### Interactions

| Interaction | What it pins |
|---|---|
| definitions read | Every claimed definition, sorted by id, naming its seed product and exactly its seed-row profiles |
| profile read for `kv.key-value/v1` | A seed product with no local engine resolves to nothing — refused, never substituted |
| gaps read | The unclaimed seed products, so claimed + gaps = the seed denominator |
| evidence read | Shipped constants do not attest themselves: `evidenceSignatureValid: false`, conformance `unknown` |

When a later layer wires a local apply/up/down loop through the camp
machinery, that integration boundary gets its own contract artifacts in
the package that owns the call.
