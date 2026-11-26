import { describe, expect, it } from "vitest";

import { buildLaunch, type LaunchInput } from "../src/launch.js";
import { placeProblem } from "../src/trust.js";
import { parsed } from "./fixtures/bindings.js";
import { refusalOf } from "./support/refusal.js";
import { dir, file, link, memoryTrust, SYSTEM } from "./support/trust-fs.js";

const ME = 1000;
const STRANGER = 4242;

const nodes = {
	...SYSTEM,
	"/opt": dir(0, 0o755),
	"/opt/kit": dir(ME, 0o755),
	"/opt/kit/bridge": dir(ME, 0o755),
	"/opt/kit/bridge/parse.mjs": file(ME, 0o644),
	"/opt/open": dir(ME, 0o777),
	"/opt/open/parse.mjs": file(ME, 0o644),
	"/opt/theirs": dir(STRANGER, 0o755),
	"/opt/theirs/parse.mjs": file(STRANGER, 0o644),
	"/opt/writable": dir(ME, 0o755),
	"/opt/writable/parse.mjs": file(ME, 0o666),
	"/opt/into-open": link("/opt/open/parse.mjs"),
	"/work": dir(0, 0o755),
	"/work/checkout": dir(ME, 0o755),
	"/work/checkout/bridge.mjs": file(ME, 0o777),
	"/work/checkout/tools": dir(ME, 0o755),
	"/work/checkout/tools/parse.mjs": file(ME, 0o644),
	"/work/checkout/node_modules": dir(ME, 0o755),
	"/work/checkout/node_modules/.bin": dir(ME, 0o755),
	"/work/checkout/node_modules/.bin/parse.mjs": file(ME, 0o755),
};

function launchWithEnv(
	env: NodeJS.ProcessEnv,
	more: Partial<LaunchInput> = {},
) {
	return buildLaunch({
		bin: "/opt/opensesame/opensesame",
		schemaPath: "/tmp/x/.env.schema",
		argv: ["node", "app.js"],
		bindings: parsed(),
		env,
		passEnv: ["OPENSESAME_STORE_PASSWORD"],
		nodeVersion: "22.22.0",
		trust: memoryTrust(nodes, { cwd: "/work/checkout" }),
		...more,
	});
}

function launchWith(
	bridge: string | undefined,
	more: Partial<LaunchInput> = {},
) {
	return launchWithEnv(
		{
			PATH: "/usr/bin",
			OPENSESAME_STORE_PASSWORD: "store-passphrase-for-tests",
			OPENSESAME_ENV_PARSE: bridge,
		},
		more,
	);
}

describe("OPENSESAME_ENV_PARSE is a program path: absolute, and in a place the rule trusts", () => {
	it("passes an absolute path to a file in a trusted place, as given", () => {
		const launch = launchWith("/opt/kit/bridge/parse.mjs");
		expect(launch.env.OPENSESAME_ENV_PARSE).toBe("/opt/kit/bridge/parse.mjs");
	});

	it("passes nothing when it is not set", () => {
		expect(launchWith(undefined).env).not.toHaveProperty(
			"OPENSESAME_ENV_PARSE",
		);
	});

	it("refuses a relative path, wherever it points: a checkout can put a script in the working directory", () => {
		for (const bridge of [
			"./bridge.mjs",
			"bridge.mjs",
			"tools/parse.mjs",
			"../checkout/bridge.mjs",
			"",
			" /opt/kit/bridge/parse.mjs",
		]) {
			const said = refusalOf(() => launchWith(bridge));
			expect(said?.code, JSON.stringify(bridge)).toBe("bridge_missing");
			expect(said?.message, JSON.stringify(bridge)).toContain("absolute");
		}
	});

	it("refuses a relative path even where the file it would resolve to passes the rule", () => {
		const trust = memoryTrust(
			{
				...nodes,
				".": dir(0, 0o755),
				kit: dir(0, 0o755),
				"kit/bridge": dir(0, 0o755),
				"kit/bridge/parse.mjs": file(0, 0o644),
			},
			{ cwd: "/work/checkout" },
		);
		expect(placeProblem("kit/bridge/parse.mjs", trust)).toBeUndefined();
		expect(
			refusalOf(() => launchWith("kit/bridge/parse.mjs", { trust }))?.code,
		).toBe("bridge_missing");
	});

	it("refuses a path in a place others could have written, with the passphrase nowhere", () => {
		for (const bridge of [
			"/opt/open/parse.mjs",
			"/opt/theirs/parse.mjs",
			"/opt/writable/parse.mjs",
			"/opt/into-open",
			"/work/checkout/bridge.mjs",
			"/work/checkout/tools/parse.mjs",
			"/work/checkout/node_modules/.bin/parse.mjs",
		]) {
			const said = refusalOf(() => launchWith(bridge));
			expect(said?.code, bridge).toBe("bridge_missing");
			expect(said?.message, bridge).toContain("OPENSESAME_ENV_PARSE");
			expect(said?.message, bridge).not.toContain("store-passphrase-for-tests");
		}
	});

	it("still refuses one that does not exist", () => {
		expect(refusalOf(() => launchWith("/opt/kit/bridge/gone.mjs"))?.code).toBe(
			"bridge_missing",
		);
	});

	it("takes an absolute Windows path, where no owner or mode is checked", () => {
		const windows = memoryTrust(
			{
				"C:\\Windows": dir(0, 0o755),
				"C:\\Windows\\System32": dir(0, 0o755),
				"C:\\kit": dir(0, 0o777),
				"C:\\kit\\parse.mjs": file(0, 0o666),
			},
			{ euid: undefined, cwd: "C:\\proj", home: "C:\\Users\\me" },
		);
		const run = (bridge: string) =>
			refusalOf(() =>
				launchWith(bridge, { platform: "win32", trust: windows }),
			);
		expect(run("C:\\kit\\parse.mjs")).toBeUndefined();
		expect(run("kit\\parse.mjs")?.code).toBe("bridge_missing");
	});

	it("on Windows finds the variable whatever its case, as the allowlist does, and checks every spelling that is passed on", () => {
		const windows = memoryTrust(
			{
				"C:\\Windows": dir(0, 0o755),
				"C:\\Windows\\System32": dir(0, 0o755),
				"C:\\kit": dir(0, 0o755),
				"C:\\kit\\parse.mjs": file(0, 0o644),
			},
			{ euid: undefined, cwd: "C:\\proj", home: "C:\\Users\\me" },
		);
		const run = (env: NodeJS.ProcessEnv) =>
			refusalOf(() =>
				launchWithEnv(env, { platform: "win32", trust: windows }),
			);
		for (const name of [
			"OPENSESAME_ENV_PARSE",
			"opensesame_env_parse",
			"Opensesame_Env_Parse",
		]) {
			expect(run({ [name]: "kit\\parse.mjs" })?.code, name).toBe(
				"bridge_missing",
			);
			expect(run({ [name]: "C:\\kit\\parse.mjs" }), name).toBeUndefined();
		}
		// Two spellings in one plain object both reach OpenSesame, so both are checked.
		expect(
			run({
				OPENSESAME_ENV_PARSE: "C:\\kit\\parse.mjs",
				opensesame_env_parse: "kit\\parse.mjs",
			})?.code,
		).toBe("bridge_missing");
	});

	it("elsewhere the name is exact: a lower-case spelling is neither passed on nor checked", () => {
		const launch = launchWithEnv({
			PATH: "/usr/bin",
			opensesame_env_parse: "./planted.mjs",
		});
		expect(
			Object.keys(launch.env).map((name) => name.toLowerCase()),
		).not.toContain("opensesame_env_parse");
	});
});
