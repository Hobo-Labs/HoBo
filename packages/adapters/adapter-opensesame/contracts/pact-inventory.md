# @hobo/adapter-opensesame PACT inventory

The boundary is a process: `opensesame dev --agent --schema <file> run -- <cmd>`.
The adapter hands it a reference-only `.env.schema` and a command, and reads
back an exit status, OpenSesame's own stderr lines, and (through the child) the
environment the command was given. The pact encodes that as synthetic HTTP:
`POST /dev/run` carries a scenario, the bindings and the command; the response
is what the adapter concluded.

| Boundary | Consumer | Provider | Protocol | Pact file/test | Provider verification | Mock used | Status |
|----------|----------|----------|----------|----------------|----------------------|-----------|--------|
| Proxied run under OpenSesame (surrogate delivery, scope refusal, placeholders, tripwire, signal, pin mismatch, unreadable store) | HoboOpenSesameAdapter | OpenSesameProxiedRun | process, synthetic HTTP | `pacts/opensesame-proxied-run-boundary.pact.json` / `consumer/opensesame-proxied-run.consumer.contract.test.ts` | `provider/opensesame-proxied-run.provider.test.ts` (stand-in binary, always); `test/real/proxied-run.provider.real.test.ts` (the real binary, `pnpm --filter @hobo/adapter-opensesame run test:real`, which fails rather than skips without `HOBO_OPENSESAME_KIT`) | stand-in binary + pact mock | provider_verified |

## Status mapping

| Adapter conclusion (`kind`) | Synthetic status |
|---|---|
| `child_exit` | 200 |
| `plugin_pin_mismatch` | 409 |
| `tripwire` | 403 |
| `signalled` | 410 |
| `scope_unbounded`, `schema_refused` | 422 |
| `store_unreadable` | 423 |
| `placeholders_only` | 424 |
| `bridge_missing` | 503 |

## Notes

- Every response carries `tokenLeaked: false`: the dummy token that stands for
  the sealed one must appear in no child environment, argument, schema, line of
  output or outcome. The consumer test refuses a pact that records otherwise.
  Against the stand-in binary that is true by construction (the stand-in never
  reads the dummy), so it proves nothing there; the proof is the real lane, where
  the token is sealed, redeemed once at a recording upstream and swept for in the
  child's environment and arguments, the output, the outcome, every file under the
  sandbox and every process. The pact says so in `metadata.tokenLeaked`.
- A run that exits 0 with a placeholder (`plugin-absent`, `no-sealed-entry`) is
  `424`, never `200`: against an emulator that accepts any token it is a false green.
- `HoboOpenSesameAdapter` and `OpenSesameProxiedRun` are participant names the
  harness accepts (`^[A-Z][A-Za-z0-9]*$`); the package names are
  `@hobo/adapter-opensesame` and the `opensesame` executable.
