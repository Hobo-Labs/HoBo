# Cloudflare CI local records

`readiness.proto` owns SDK readiness and the binary-safe native command envelope.
Both runtime records are generated under `src/_generated`. `cf.cue` constrains both
message types and its `#Cf` union validates valid/invalid fixture instances through
schema-tools. Shared pipeline, result, artifact and lease data remain owned by
`@hobo/ci`; no parallel hand-declared wire interfaces are introduced here.

Local preparation, health/status, run state/events and durable receipts are also
protobuf-owned. CUE rejects false-success states. `resultJson` embeds the canonical
shared `@hobo/ci` PipelineResult JSON; it is not a second pipeline/result schema.
