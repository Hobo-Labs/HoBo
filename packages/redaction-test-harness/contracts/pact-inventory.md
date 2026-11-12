# PACT inventory

`@hobo/redaction-test-harness` is a test-only, in-process library: a test links
it and calls it in its own process, so it owns no service boundary. The one
pact, `pacts/redaction-test-harness-boundary.pact.json`, records that.

| Boundary | Consumer | Provider | Protocol | Pact file/test | Provider verification | Mock used | Status |
|---|---|---|---|---|---|---|---|
| redaction-test-harness-boundary | RedactionTestSuite | RedactionTestHarnessPackage | in-process | pacts/redaction-test-harness-boundary.pact.json | n/a | n/a | consumer_tested |
