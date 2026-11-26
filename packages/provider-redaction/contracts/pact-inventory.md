# PACT inventory

`@hobo/provider-redaction` is an in-process library: every caller links it and
calls it in its own process, so it owns no service boundary. The one pact,
`pacts/provider-redaction-boundary.pact.json`, records that.

| Boundary | Consumer | Provider | Protocol | Pact file/test | Provider verification | Mock used | Status |
|---|---|---|---|---|---|---|---|
| provider-redaction-boundary | ProviderErrorPath | ProviderRedactionPackage | in-process | pacts/provider-redaction-boundary.pact.json | n/a | n/a | consumer_tested |
