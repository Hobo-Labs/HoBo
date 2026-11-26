import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { RESERVED_ENV_NAME_PATTERN } from "../src/binding.js";
import { OpenSesameAdapterError } from "../src/errors.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	parseJsonValue,
} from "../src/json.js";
import { parsed, vercelRecord } from "./fixtures/bindings.js";

const here = dirname(fileURLToPath(import.meta.url));
const LISTS = ["TRUST_VARS", "PROXY_VARS", "NO_PROXY_VARS"] as const;

/** OpenSesame's three lists of variables a binding may not name. */
type ReservedLists = {
	TRUST_VARS: string[];
	PROXY_VARS: string[];
	NO_PROXY_VARS: string[];
};

function fixture(): ReservedLists {
	const document = parseJsonValue(
		readFileSync(join(here, "fixtures/opensesame-reserved-vars.json"), "utf8"),
	);
	if (!isJsonObject(document)) throw new Error("the fixture is not an object");
	const out: Record<string, string[]> = {};
	for (const list of LISTS) {
		const names = document[list];
		if (!isJsonArray(names) || !names.every(isJsonString)) {
			throw new Error(`${list} is not a list of strings`);
		}
		out[list] = names.filter(isJsonString);
	}
	return {
		TRUST_VARS: out.TRUST_VARS ?? [],
		PROXY_VARS: out.PROXY_VARS ?? [],
		NO_PROXY_VARS: out.NO_PROXY_VARS ?? [],
	};
}

/** The `&[&str]` lists of OpenSesame's env.rs, read as text. */
function listsIn(source: string): ReservedLists {
	const out: Record<string, string[]> = {};
	for (const list of LISTS) {
		const body = new RegExp(
			`pub const ${list}: &\\[&str\\] = &\\[([^\\]]*)\\];`,
			"u",
		).exec(source)?.[1];
		if (body === undefined) throw new Error(`${list} not found in env.rs`);
		out[list] = [...body.matchAll(/"([^"]+)"/gu)].map(
			(match) => match[1] ?? "",
		);
	}
	return {
		TRUST_VARS: out.TRUST_VARS ?? [],
		PROXY_VARS: out.PROXY_VARS ?? [],
		NO_PROXY_VARS: out.NO_PROXY_VARS ?? [],
	};
}

function refusal(envName: string): string {
	try {
		parsed(vercelRecord({ env_name: envName }));
	} catch (error) {
		if (error instanceof OpenSesameAdapterError) return error.code;
		throw error;
	}
	return "accepted";
}

describe("every variable OpenSesame's own refusal names is reserved here too", () => {
	const reserved = new RegExp(RESERVED_ENV_NAME_PATTERN, "u");

	it("refuses each upper-case name in OpenSesame's lists as reserved_env_name, not late as a schema refusal", () => {
		const names = LISTS.flatMap((list) => fixture()[list]).filter(
			(name) => name === name.toUpperCase(),
		);
		expect(names).toContain("REQUESTS_CA_BUNDLE");
		expect(names).toContain("CURL_CA_BUNDLE");
		expect(names).toContain("GIT_SSL_CAINFO");
		for (const name of names) {
			expect(reserved.test(name), name).toBe(true);
			expect(refusal(name), name).toBe("reserved_env_name");
		}
	});

	it("matches the checkout's own lists when OPENSESAME_SOURCE names one", () => {
		const root = process.env.OPENSESAME_SOURCE;
		// The fixture comparison above always runs; this one needs a checkout and says so by its variable.
		if (root === undefined) return;
		const file = join(root, "crates/surrogate-proxy/src/env.rs");
		expect(existsSync(file), file).toBe(true);
		expect(listsIn(readFileSync(file, "utf8"))).toEqual(fixture());
	});

	it("reads OpenSesame's env.rs in the shape the fixture was copied from", () => {
		const sample = `pub const TRUST_VARS: &[&str] = &[\n    "A_B",\n    "C",\n];\npub const PROXY_VARS: &[&str] = &["P", "p"];\npub const NO_PROXY_VARS: &[&str] = &["N", "n"];`;
		expect(listsIn(sample)).toEqual({
			TRUST_VARS: ["A_B", "C"],
			PROXY_VARS: ["P", "p"],
			NO_PROXY_VARS: ["N", "n"],
		});
	});
});
