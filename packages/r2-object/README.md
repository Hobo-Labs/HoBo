# R2 object operations

This shared storage client provides bounded, conditional reads and writes to a
private R2 bucket. Cloudflare and Upstash adapters use the same implementation
without importing one another. The caller supplies independently scoped
credentials and a guarded transport. Transport failures leave write outcomes
unknown, and unconditional writes and deletes are not offered. A successful
write without a strong ETag is applied, but its caller must read the object
before using an ETag for a later conditional write.

The package applies parse, don't validate at its public boundary: account,
bucket, jurisdiction, capacity, timeout, object key and ETag are checked before
building a scoped request. These parsed domain types and their constraints are
recorded in `data-models/`; the client accepts ordinary TypeScript inputs and
rejects invalid inputs rather than exposing unverified values to its transport.
The Protobuf and CUE records describe the boundary; the R2 HTTP API itself does
not serialize them. `contracts/pacts/` records the HTTP interaction contract,
and its consumer tests replay those interactions through the real client. The
in-memory origin test also verifies conditional-write behavior; neither test
claims to verify a live R2 service.

This client sends object read and conditional-write commands, but it is not an
actor or an event store. It emits no domain events and owns no materialized view,
projection, snapshot or read store. The caller owns any journal and its
reconciliation of unknown write outcomes; the remote R2 service stores objects.
