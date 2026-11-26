# Azure DevOps Pact inventory

| Boundary | Consumer | Provider | Protocol | Pact file/test | Provider verification | Mock used | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Pool discovery and revision/preview | ADO live acceptance client | Azure DevOps REST 7.1 | HTTP JSON | `live.pact.json`; `test/live.test.ts`, `live.consumer.test.ts` | local consumer verification only | shared contract harness with ordered recorded interactions and loopback HTTP | consumer_tested |
| Pinned queue, status, timeline and artifact retention | ADO live acceptance client | Azure DevOps REST 7.1 | HTTP JSON | `live.pact.json`; same tests | local consumer verification only | same Pact broker; exact request fidelity and completion checks | consumer_tested |
| Cancellation, reconciliation and refusal states | ADO live acceptance client | Azure DevOps REST 7.1 | HTTP JSON | `live.pact.json`; same tests | local consumer verification only | recorded cancellation, authorization, redirect and malformed response interactions | consumer_tested |
| Boundary, identity, response and deadline edge cases | ADO live acceptance client | Azure DevOps REST 7.1 | HTTP JSON and delivery faults | `live-edge.pact.json`; `test/edges/live.test.ts` | local consumer verification only | same strict broker with recorded edge states; framing/stall faults around recorded messages | consumer_tested |
| Native artifact publish/download | Generated Azure YAML and actual Bash/CLI | Azure Pipeline Artifact tasks | synchronous task input messages | `pipeline.pact.json`; `pipeline.consumer.test.ts`, `test/production.test.ts` | local consumer verification only | Pact-checked filesystem task host transfers real collected bytes | consumer_tested |

Fixtures are hand-authored consumer expectations. A real loopback HTTP exchange
verifies the consumer transport; it does not verify the Microsoft service.
No Pact Broker publication or live Azure verification is asserted by this lane.
