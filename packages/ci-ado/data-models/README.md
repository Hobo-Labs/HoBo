# Azure Pipelines authoring contracts

`project.proto` owns `AdoProject`, artifact reports, live acceptance targets/results
and the consumed Azure REST/compiled YAML projections. Generated records live in
`src/_generated/project_pb.ts`. `project.cue` and its valid/invalid fixtures pin
the version, self-hosted pool, unique demands, literal workspace-relative plan path
and artifact prefix, environment references, literal bootstrap/runner argv and
artifact verification options, including conflicts with the Linux requirement.
`parseAdoProject` applies these constraints to derive the immutable parsed type.

The referenced command plan and execution result use `@hobo/ci` Protobuf/CUE
contracts. Credentials are environment references; values are never serialized
in project/target/report records. Account balances and leases remain owned by
`@hobo/ci`. Consumer Pacts cover YAML publication and the live timeline response;
no live provider verification follows from these local fixtures.
