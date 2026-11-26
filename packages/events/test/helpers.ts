import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	createManualClock,
	createRuntimeLocalEventStore,
	type RuntimeLocalEventStore,
} from "@hobo/runtime-local";

export function freshStore(): RuntimeLocalEventStore {
	const dir = mkdtempSync(join(tmpdir(), "hobo-events-"));
	return createRuntimeLocalEventStore({
		dataDir: dir,
		clock: createManualClock(),
	});
}

export const ACTOR = { kind: "user", id: "u1" } as const;
export const CTX = { tenant: "tenant-a", actor: ACTOR };
