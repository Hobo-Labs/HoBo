# Forge Ingestion

`runForgeIngestion()` resolves recorded provider sources, parses and sanitizes
them, creates a generation request, emits an executable provider adapter, and
compiles the result. The generated adapter binds the target WIT port and
equivalence mapping to a caller-supplied database implementation.

Every ingestion step emits a `forge.*` or `gen.*` event. Unsafe material is
refused before package generation, and custom reasoning engines can augment the
emitted package without changing the preceding event order.

Run:

```bash
pnpm --prefix src/draft/technical-proofs/s5-03-forge-ingestion-contract test
pnpm --prefix src/draft/technical-proofs/s5-03-forge-ingestion-contract run forge -- fixture://mock-postgres-backend
```
