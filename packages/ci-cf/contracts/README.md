# Cloudflare CI executable boundaries

Readiness and native SDK consumer contracts are in the local Pact inventory.
`readiness.consumer.test.ts` invokes the real getter/parser;
`native-context.consumer.test.ts` invokes the shipped backend against the native
SDK context contract, which executes actual local shell steps and snapshots.
Neither contract calls a remote provider or claims vendor verification.

`local-source.consumer.test.ts` pins the local image archive checkout, disabled
remote source credentials/reporting and binding-backed backups, including when
the native SDK would select FUSE. `test/local.test.ts` characterizes the generated
Wrangler config and prepares actual Git archives without uncommitted host files.

Both build and typecheck compile the Worker example against pinned upstream types.
The protobuf/CUE gate exercises readiness and command-envelope fixture instances.
