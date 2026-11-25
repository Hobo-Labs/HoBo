# `@hobo/management`

Pure Station / Rail / Connection / broker-status management functions.

Shared by:

- `hobo station` / `hobo connection` CLI
- MCP control tools
- `@hobo/control-api` (local HTTP + SSE for the Yard game UI)

## Usage

```ts
import {
  createManagementContext,
  stationInit,
  stationStatus,
  connectionCreate,
  projectYardSnapshot,
} from "@hobo/management";

const ctx = createManagementContext({ hoboHome: "/tmp/hobo-home" });
const init = stationInit(ctx, { name: "local", tenant: "local" });
const snap = projectYardSnapshot(ctx, { stationId: init.data!.stationId });
```

## Gates

- `pnpm --filter @hobo/management test`
- Architecture: protobuf/CUE under `data-models/`, PACT under `contracts/pacts/`
