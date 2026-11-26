# Contracts

Two boundaries cross out of this package, and only one of them is HTTP.

## 1. The host asset origin — `provider-browser-wasm-host-origin.pact.json`

The consumer-driven contract for the `/_hobo/` routes the host page serves:
the capability report for the browsing context, the guest manifest, and the
component bundle itself. `@hobo/provider-browser-wasm` is the consumer; the
page's own origin is the provider.

`test/contract.test.ts` replays every interaction through the real
`createHostAssetClient`, asserting that the request the client emits still
matches the one the pact declares and that the client behaves as documented when
handed the pact's recorded response. The fake sits at the HTTP seam; the
parsers, the same-origin guard and the **real Web Crypto digest over the pact's
real bytes** are all the shipping ones.

**Only the consumer half is verified.** The provider half is whatever a HoBo
host page serves, and this package's default test lane starts no page. The pact
pins what this client sends and records — with a `metadata.source.checkedAt`
date — what the routes are expected to answer.

### Interactions

| Interaction | What it pins |
|---|---|
| cross-origin isolated context | `GET /_hobo/host/capabilities`, and that COOP/COEP plus durable OPFS is a coherent answer |
| private-mode context | `persistence: "unavailable"` is an **answer**, not an error |
| guest manifest | Digest, byte length, WIT world, imports/exports, and a `componentPath` inside the guest's own directory |
| component bundle | `application/wasm`, the digest in the `ETag`, `Cross-Origin-Resource-Policy: same-origin` |
| single-page-app document | A 200 `text/html` where a missing `.wasm` should have 404ed — the most common static-host misconfiguration |
| bytes that do not match | Digest mismatch, caught before instantiation |
| core module with a correct digest | Right bytes, wrong layer: a component was expected |
| `GUEST_NOT_FOUND` | The origin's own fault envelope, mapped to `BUNDLE_UNAVAILABLE` |

### Binary bodies

A WebAssembly bundle is not JSON, so those interactions record their body as
base64 and say so with `"encoding": "base64"`. The replay decodes it and the
digest is computed over the decoded bytes — that is the whole point: the pact
carries the actual component fixture, not a description of one.

The fixture is an 8-byte component-model preamble (`\0asm`, version `0x0d`,
layer `1`) and its core-module twin (`\0asm`, version `1`, layer `0`). They are
the smallest pair that can tell the two apart, which is exactly the distinction
`verifyComponentArtifact` has to make.

### Credentials in this directory

There are none, and there is nothing here to authenticate to. The routes are
the host page's own, served to the page that is going to run the guest.

## 2. `GuestRuntimePort` — the host/guest boundary

Instantiation is not HTTP. It is a same-process act performed by whatever runs
the component — a dedicated worker in a browser — and it is expressed as a port
in `src/host-runtime.ts` rather than a pact.

What that port owes the driver is small and is verified in
`test/contract.test.ts`: it declares the WIT interfaces it can supply (so a
missing import is refused before the bundle is even downloaded, instead of
surfacing as a link error from inside the runtime), and its `terminate` reports
truthfully whether the worker stopped and the partition went, because
`releaseGuest` turns those two booleans into the difference between `released`
and `CLEANUP_INCOMPLETE`.

Outside a browser the port's default implementation is
`createUnavailableRuntime`, which fails closed.
