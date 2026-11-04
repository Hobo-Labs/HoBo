# Try-site examples

These four examples drive the static `/examples/` Home Station console. Each
`apps/<id>/` folder owns display metadata, a Bindle definition with its
executable runtime routes, and sparse deployment policy. `yards.json` is the registered
provider-specific Yard pool; each Yard has exactly one provider, while a
Junction composes the Yards selected by policy.

## Environment Station authoring (Pool Code)

Pool Code shows the minimum deploy surface — import provider plugins and list
them. Capabilities / resource-class matching stay inside provider packages
(`EQUIVALENCE_CLASSES` → Matching default Resource Definitions).

```ts
import { station } from "@hobo/stations";
import { cloudflare } from "@hobo/provider-cloudflare";
import { lakebed } from "@hobo/provider-lakebed";

export default station({
  yards: [lakebed, cloudflare],
});
```

Local helpers:

- `environment-station.ts` / `station.ts` — Examples alias so samples can write
  `station({ yards })` without changing ADR-0131 `@hobo/stations` Bindles.
- `yards/<target>.deploy.ts` — one-line default re-exports from real
  `@hobo/provider-*` packages (no thin tokens).

Canonical sample: `station.deploy.ts`.

## Temporary / agent stamps (no permanent tokens)

| Yard | Package | Examples path |
|---|---|---|
| cloudflare | `@hobo/provider-cloudflare` | `/api/cf-temp` Temporary Accounts |
| lakebed | `@hobo/provider-lakebed` | `/api/lakebed-temp` anonymous deploy |
| vercel | `@hobo/provider-vercel` | `/api/vercel-temp` [Vercel Drop](https://vercel.com/docs/drop) |
| browser-wasm / webernetes / netlify | matching `@hobo/provider-*` | `/api/provider-temp/:id` |

Railway is **not** an Examples OOB yard (no anon/temp deploy API).

Shared result shape: `hobo.temporary-environment-station/v1` (`@hobo/core`).

To add an example:

1. Copy an existing app folder and give `meta.json` a unique DNS-safe id.
2. Declare required Bindle capabilities and the exported executable `runtime`
   contract together in `app.ts`.
3. Keep policy sparse. Values merge as defaults → app policy → deployment
   policy; `maxReplicas` limits independent host previews and `maxConcurrent`
   only limits bootstrap workers. Redundancy and routing values are placement
   intent here; the static demo does not implement cross-host failover or mirroring.
4. Add the Yard ids the example may use. An omitted allow-list means any Yard
   in its declared Junction, never every provider automatically.
5. Run `pnpm --prefix examples/try-site test` and the site tests/build.

GitHub Pages never receives provider credentials.

## Maintenance

App definitions use typed component constructors, parsed dynamic modules, explicit Node types, and decorator metadata compatible with exact optional properties.
