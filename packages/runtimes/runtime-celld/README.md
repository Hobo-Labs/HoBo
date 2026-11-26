# `@hobo/runtime-celld`

Experimental **Durable Objects dialect** for [celld](https://github.com/denoland/celld).

This is **not**:

- a HoBo WASM Component Model / WIT host
- a multi-tenant public actor service
- a filesystem-local `hobo dev` default
- a Flux-hosted fleet (recipe status: `unsupported` until overlay proofs exist)

It **is** a Camp runtime adapter: overlay-required, operator port private, CAS bucket (`s3`/`gs`/`r2`), one fleet per trust boundary. Bindles still author `actor()`. Workers/Wrangler is a scored Camp escape.

See `ARCHITECTURE.md`.

## Live lane

Live baremetal / deploy / Worker-module tests require the pinned `celld`
binary (`CELLD_BIN`, default `/tmp/hobo-live/bin/celld`). A missing binary
is a failure, not a skip.

Install it from the pinned OCI image (`src/upstream-pin.ts`; upstream publishes
no release assets for `v0.2.1`, only the image):

```bash
pnpm --filter @hobo/runtime-celld run fetch:celld   # or: npx tsx scripts/fetch-celld.mts
```

`scripts/fetch-celld.mts` walks image index → per-platform manifest → layers,
selecting by `platform.os`/`platform.architecture` (the index also carries two
attestation manifests reporting `unknown/unknown`; they contain no binary), and
**verifies the sha256 of the index, the manifest, the config, and every layer
blob against the digest its parent declares before decompressing, extracting or
chmod-ing anything.** A mismatch refuses with `CELLD_DIGEST_MISMATCH` and writes
nothing — the pin exists so that trust is checkable, and the test suite executes
what this installs. linux/amd64 and linux/arm64 are both supported; anything
else refuses with `CELLD_PLATFORM_UNSUPPORTED`.

The install is idempotent: a `<bin>.pin.json` sidecar records the pin digest and
the installed file's hash, and a matching, intact binary is left alone. Pass
`--force` to reinstall. `pretest` runs the fetch, so `turbo run test` is
self-sufficient given network access; `CELLD_BIN`, `CELLD_ESBUILD`, the proxy
variables and `NODE_EXTRA_CA_CERTS` are all in `turbo.json`
`globalPassThroughEnv`. On a TLS chain rejection the script names the URL and
`NODE_EXTRA_CA_CERTS`; it never disables verification.

`celld deploy` bundles with esbuild. `CELLD_ESBUILD` overrides the path;
otherwise `test/helpers/toolchain.ts` resolves the native esbuild binary the
workspace already installs. Neither lookup can turn a live test into a skip.
Baremetal diagnostics bind an ephemeral loopback port rather than assuming the
default 8080 is free.
