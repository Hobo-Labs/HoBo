import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ENDING_SIGNALS } from "@hobo/code/ending-signals";
import { describe, expect, it } from "vitest";

import { parseJsonValue } from "../src/json.js";

// The signals on which an entry point's owned directories are removed are
// hobo-code's ending signals, one list (`@hobo/code/ending-signals`), read in
// its order rather than written out again in an order of this module's own.

const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");
const FIXTURE = fileURLToPath(
	new URL("./fixtures/owned-temp-dir-signal-order.mts", import.meta.url),
);

describe("removeOwnedDirsOnSignals", () => {
	it("handles hobo-code's ending signals, as that one list gives them", () => {
		const ran = spawnSync(process.execPath, ["--import", TSX_LOADER, FIXTURE], {
			env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" },
			encoding: "utf8",
		});
		expect(ran.status, ran.stderr).toBe(0);
		expect(parseJsonValue(ran.stdout.trim())).toEqual([...ENDING_SIGNALS]);
	}, 60_000);
});
