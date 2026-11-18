# Generation Template Stage

`scaffoldGenerationRequest()` emits deterministic, content-addressed,
executable templates from authoritative generation inputs. Supported templates
cover database providers, database resource definitions, service handlers,
Terraform state import, and reactive views.

Every template is valid JavaScript, contains no deferred regions, and exposes a
working default or an explicit dependency-injection boundary. Unsupported
artifact and port combinations emit `gen.NeedsHuman`.

Run `pnpm --prefix src/draft/technical-proofs/generation-scaffold-stage-contract test`.
