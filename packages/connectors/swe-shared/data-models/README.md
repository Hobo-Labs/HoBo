# SWE-task data models

`swe_task.proto` is the wire contract for the shared SWE-task session records
(HOBO-722..726); `swe_task.cue` mirrors its invariants (non-empty ids, fixed
report schema ids, `clean` ⇔ no out-of-scope access).

The package is opted into buf codegen (`buf.yaml` present): `pnpm run codegen`
(@hobo/schema-tools → buf/protoc-gen-es) emits `src/_generated/swe_task_pb.ts`,
and `src/swe-task.ts` consumes those generated types. Never hand-edit the
generated output; change the proto and regenerate. `pnpm run codegen:check`
is the drift gate.
