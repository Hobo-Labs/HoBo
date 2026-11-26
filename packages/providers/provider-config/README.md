# `@hobo/provider-config`

Linked **`wasi:config/store`** provider for HoBo (ADR-0142).

- **Import-optional** — only linked when a component imports config.
- **Memory offline default** — not OpenBao/Vault.
- **value-ref + sensitivity** — not ambient secret env.
- **Not residual secrets** — use `@hobo/identity` SecretsPort / optional adapters.

```ts
import {
  createMemoryConfigStore,
  linkConfigStoreIfImported,
} from "@hobo/provider-config";

const store = linkConfigStoreIfImported({
  imports: ["wasi:config/store@0.2.0"],
});
store?.put("LOG_LEVEL", { value: "info", sensitivity: "public" });
const v = store?.get("LOG_LEVEL");
// { key, value-ref, sensitivity }
```
