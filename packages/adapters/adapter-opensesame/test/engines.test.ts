import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { OpenSesameAdapterError } from "../src/errors.js";
import { isJsonObject, isJsonString, parseJsonValue } from "../src/json.js";
import { buildLaunch } from "../src/launch.js";
import { parsed } from "./fixtures/bindings.js";

const here = dirname(fileURLToPath(import.meta.url));

function enginesNode(): string {
	const manifest = parseJsonValue(
		readFileSync(join(here, "../package.json"), "utf8"),
	);
	const engines = isJsonObject(manifest) ? manifest.engines : null;
	const node = isJsonObject(engines) ? engines.node : null;
	if (!isJsonString(node))
		throw new Error("package.json names no engines.node");
	return node;
}

/** `^M.m.p` and `>=M`, the two clause forms the range may use, evaluated without a semver package. */
function admits(range: string, version: string): boolean {
	const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
	return range.split("||").some((clause) => {
		const text = clause.trim();
		const caret = /^\^(\d+)\.(\d+)\.(\d+)$/u.exec(text);
		if (caret !== null) {
			const [, m = 0, n = 0, p = 0] = caret.map(Number);
			return major === m && (minor > n || (minor === n && patch >= p));
		}
		const atLeast = /^>=(\d+)$/u.exec(text);
		if (atLeast !== null) return major >= Number(atLeast[1]);
		throw new Error(`a range clause this test does not read: ${text}`);
	});
}

function launchAccepts(nodeVersion: string): boolean {
	try {
		buildLaunch({
			bin: "/opt/opensesame/opensesame",
			schemaPath: "/tmp/x/.env.schema",
			argv: ["node", "app.js"],
			bindings: parsed(),
			env: { PATH: "/usr/bin" },
			nodeVersion,
		});
		return true;
	} catch (error) {
		if (
			error instanceof OpenSesameAdapterError &&
			error.code === "node_proxy_unsupported"
		) {
			return false;
		}
		throw error;
	}
}

describe("engines.node is the range the launch accepts", () => {
	it("admits exactly the versions the launch does not refuse, Node 23 included", () => {
		const range = enginesNode();
		for (const version of [
			"20.19.0",
			"22.4.1",
			"22.20.9",
			"22.21.0",
			"22.22.0",
			"22.99.0",
			"23.0.0",
			"23.11.0",
			"24.0.0",
			"24.9.1",
			"25.1.0",
		]) {
			expect(admits(range, version), `${version} against ${range}`).toBe(
				launchAccepts(version),
			);
		}
	});

	it("does not admit Node 23, which has no NODE_USE_ENV_PROXY", () => {
		expect(admits(enginesNode(), "23.11.0")).toBe(false);
		expect(launchAccepts("23.11.0")).toBe(false);
	});
});
