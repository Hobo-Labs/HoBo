# @hobo/camps

`camp()` creates a provider-neutral Camp. Attach it to a Yard to derive its
provider, and use a deployment request to place a Bindle in that Camp.

```ts
import { camp } from "@hobo/camps";
import { yard } from "@hobo/yards";

const production = camp("production", { logicalId: "checkout/production" });
const east = yard("east", { provider: "aws", camps: [production] });
const west = yard("west", { provider: "gcp", camps: [production] });
```

The `logicalId` identifies the Camp across placements; its `id` identifies the
placement in a Yard. A live move uses a Trail to transfer state and cut over.
Changing a declaration alone does not transfer data or remove resources.

`resolveLocalBindings` resolves the environment bindings in a wiring manifest
through a supplied resolver for Camps attached to a local Yard.

```bash
pnpm --filter @hobo/camps run build
pnpm --filter @hobo/camps run typecheck
pnpm --filter @hobo/camps run test
```
