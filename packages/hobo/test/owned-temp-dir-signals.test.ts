import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseJsonValue } from "../src/json.js";

const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");
const FIXTURE = fileURLToPath(
	new URL("./fixtures/owned-temp-dir-signal-order.mts", import.meta.url),
);

describe("removeOwnedDirsOnSignals", () => {
	it("handles the supported terminating signals in order", () => {
		const ran = spawnSync(process.execPath, ["--import", TSX_LOADER, FIXTURE], {
			env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" },
			encoding: "utf8",
		});
		expect(ran.status, ran.stderr).toBe(0);
		expect(parseJsonValue(ran.stdout.trim())).toEqual([
			"SIGINT",
			"SIGTERM",
			"SIGHUP",
			"SIGQUIT",
		]);
	}, 60_000);
});
