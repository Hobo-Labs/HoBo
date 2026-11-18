# `@hobo/runtime-browser`

`createBrowserEventStore` runs the shared SQLite journal in a dedicated browser
worker. With OPFS available, the store uses the `opfs-sahpool` VFS and retains
events, snapshots, and checkpoints across page reloads. Each partition has one
active owner. Await `close()` before reopening the same partition.

```ts
import { createBrowserEventStore } from "@hobo/runtime-browser";

const store = await createBrowserEventStore({ partitionId: "my-project" });
await store.append("notes:1", [{ type: "note.Saved", data: { text: "Hello" } }], {
  expectedSeq: 0,
  actor: { kind: "system", id: "browser" },
  tenant: "my-project",
});
await store.close();
```

When durable storage cannot open, the factory throws
`PersistenceUnavailableError`. Pass `allowTransient: true` to permit an
in-memory fallback; its contents are lost when the store closes. The reported
`persistenceMode` identifies the mode actually opened.

The package build places `sqlite3.wasm` beside the compiled worker. Browser
bundlers must include the worker module and that asset alongside the app bundle.
The default VFS does not require cross-origin isolation.

Run `pnpm run test:browser-storage` from the repository root to exercise a real
Chromium worker and OPFS store, including reopening events, snapshots, and
checkpoints. Set `HOBO_CHROMIUM_PATH` when Chromium is not at the default path.
