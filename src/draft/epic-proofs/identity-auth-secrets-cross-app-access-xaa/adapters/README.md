# Mocked Adapters

This reference implementation keeps adapters as deterministic in-memory seams.

No adapter calls a live provider, IdP, KMS, SIEM, Relay, policy engine, secret store, or cloud STS endpoint. The Pact files in `../contracts/pacts/` define the boundary shapes that a production provider would need to satisfy later.
