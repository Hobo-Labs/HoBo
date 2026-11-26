import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runProxied } from "../src/launch.js";
import { trustedOpenSesame } from "../src/opensesame-bin.js";
import { parsed } from "./fixtures/bindings.js";
import { refusalOf, refusalOfAsync } from "./support/refusal.js";
import { dir, file, memoryTrust } from "./support/trust-fs.js";

/** Every system directory the fixed fallback names is one the rule refuses: owned by the user, open to all. */
const OPEN_SYSTEM = {
	"/": dir(0, 0o755),
	"/usr": dir(0, 0o755),
	"/usr/bin": dir(1000, 0o777),
	"/usr/local": dir(0, 0o755),
	"/usr/local/bin": dir(1000, 0o777),
	"/bin": dir(1000, 0o777),
	[process.execPath]: file(0, 0o755),
};
const trust = memoryTrust(OPEN_SYSTEM, { cwd: "/work/checkout" });

let work = "";
beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), "hobo-fallback-test-"));
});
afterEach(() => {
	rmSync(work, { recursive: true, force: true });
});

describe("when no directory passes the rule, nothing is started and the passphrase goes nowhere", () => {
	it("the --version probe is not run with a PATH the rule refused", () => {
		let probed = 0;
		const said = refusalOf(() =>
			trustedOpenSesame({
				bin: process.execPath,
				env: { PATH: "/usr/local/bin" },
				platform: "linux",
				trust,
				probe: () => {
					probed += 1;
					return { status: 0, stdout: "opensesame 0.1.0\n" };
				},
			}),
		);
		expect(said?.code).toBe("bridge_missing");
		expect(probed).toBe(0);
	});

	it("runProxied refuses before it writes a schema or starts OpenSesame, with the passphrase listed in passEnv", async () => {
		let spawned = 0;
		const said = await refusalOfAsync(() =>
			runProxied({
				bin: process.execPath,
				bindings: parsed(),
				argv: ["node", "app.js"],
				env: {
					PATH: "/usr/local/bin",
					OPENSESAME_STORE_PASSWORD: "store-passphrase-for-tests",
				},
				passEnv: ["OPENSESAME_STORE_PASSWORD"],
				platform: "linux",
				trust,
				tmpRoot: work,
				probe: () => ({ status: 0, stdout: "opensesame 0.1.0\n" }),
				stderr: new PassThrough(),
				signals: { on: () => undefined, off: () => undefined },
				spawn: () => {
					spawned += 1;
					throw new Error("started");
				},
			}),
		);
		expect(said?.code).toBe("bridge_missing");
		expect(said?.message).not.toContain("store-passphrase-for-tests");
		expect(spawned).toBe(0);
		expect(readdirSync(work)).toEqual([]);
	});
});
