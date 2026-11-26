# Mocked Adapters

Adapters are intentionally fixture-backed. No adapter calls live clouds, OAuth providers, secret stores, package registries, or WIT compiler services.

The service module exposes contract-shaped responses that stand in for the eventual SDK WIT collector, manifest registry, gates, codegen workspace, local runtime harness, topology lowerer, Hobo Code parser, auth contract provider, secret resolver, and parity report provider.
