# Self-host Station (real composition)

Station is the hard control-plane isolation boundary a Conductor occupies
([ADR-0131](../../docs/design/adr/01-architecture-core.md#adr-0131)).
App topology remains Bindle ⊂ Camp ⊂ Yard ⊂ Junction — Station does **not**
contain Yards.

This example composes a **durable local Station** the same way
[`self-host-yard`](../self-host-yard/README.md) composes a YardRuntime: the
operator owns the data root, init is explicit, and history survives restart.

## Composition API

```ts
import { openSelfHostedStation } from "./src/station.js";

const station = openSelfHostedStation({
  hoboHome: "/var/lib/my-hobo", // or process.env.HOBO_HOME
});

console.log(station.status());
// { stationId, dataDir, pins: { stationId, railHash, bootstrapActive }, … }

const pins = station.pins(); // for Broker receipts
station.close(); // durable events stay under hoboHome/stations/
```

| File | What it is |
|---|---|
| `src/station.ts` | `openSelfHostedStation` / topology — initStation + StationClient on disk |
| `test/station.test.ts` | Create, pin stability, idempotent reopen, isolation |

## CLI path (same HOBO_HOME)

```bash
export HOBO_HOME="${HOBO_HOME:-$HOME/.hobo}"
hobo station init
hobo station status
hobo station up
hobo doctor
```

## Honesty

- Local file-backed Station (`events.jsonl`), not multi-tenant SaaS occupancy.
- Does not provision cloud resources; pairs with self-host-yard for app deploy.
- Live multi-Station federation remains out of scope here.

## Scripts

```sh
pnpm --filter @hobo/example-self-host-station test
```

## Maintenance

Station initialization builds its options immutably so readonly configuration remains type-safe.
