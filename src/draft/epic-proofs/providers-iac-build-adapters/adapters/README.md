# Mocked Adapter Boundaries

Adapters here are reference-boundary descriptions only. They do not call Pulumi, OpenTofu, Crossplane, CDKTF, Dagger, Packer, Firecracker, Vagrant, cloud APIs, provider CLIs, registries, model providers, or live DNS/network services.

Production adapters must satisfy the Pact fixtures in `../contracts/pacts/` and the provider-conformance suites before they can be selected by Matching or the Dispatcher.
