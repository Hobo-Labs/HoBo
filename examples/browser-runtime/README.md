# Browser WIT Environment Station

The GitHub Pages Examples console builds one real WebAssembly Component Model
guest for its browser-local Environment Stations. The guest behavior is derived
from each validated `examples/try-site/apps/*/app.ts` runtime export and crosses
the `hobo:try/browser-station@0.1.0` WIT `invoke` export. For this static local
runtime, KV and queue state is component-local memory; no host capability import
or remote-provider binding is claimed.

```bash
node --import tsx site/scripts/build-browser-wit-runtime.mts
```

The build uses the pinned `componentize-js` and jco installations already owned
by `@hobo/runtime-wasm`, passes the sandbox `station.wit` **inline as `witWorld`**
(not as a `witPath` file read inside componentize-js), bundles jco's browser shims,
and writes generated assets to `site/public/examples/runtime/`. It does not consume
the synthetic contract bytes from `@hobo/componentize`. Component bytes from
`componentize-js` are not byte-reproducible; the generated manifest records the
exact build digest and source digest used by the page.

The Home Station fetches those static bytes, but the sandboxed blob document
creates the module/WASM blob URLs, initializes the component, and invokes it.
Only `ready` or `error` lifecycle status crosses back to the Home Station.
Neither application operations nor credentials cross that channel.

The WIT world is the executable contract for this in-document component boundary.
`site/data-models/browser_station.proto` is its generated TypeScript record source,
`browser_station.cue` pins request/response constraints, and the runtime contract
test reconciles those views. Catalog/runtime parsers refine every repository and
fetched JSON value before use. PACT remains reserved for a future service transport;
this example has no remote provider bridge or persistence port.
