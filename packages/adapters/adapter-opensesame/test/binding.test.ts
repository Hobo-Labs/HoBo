import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	CONNECTION_PATTERN,
	ENV_NAME_PATTERN,
	LOCATOR_PATTERN,
	PATH_NO_DOT_SEGMENT_PATTERN,
	PATH_NO_EMPTY_SEGMENT_PATTERN,
	PATH_PATTERN,
	parseCredentialBindings,
	RESERVED_ENV_NAME_PATTERN,
} from "../src/binding.js";
import { OpenSesameAdapterError } from "../src/errors.js";
import type { JsonObject, JsonValue } from "../src/json.js";

const here = dirname(fileURLToPath(import.meta.url));

type Scope = {
	readonly bounded: readonly string[];
	readonly unbounded: readonly string[];
	readonly methods: {
		readonly valid: readonly string[];
		readonly invalid: readonly string[];
	};
};

// Copied from OpenSesame spec/conformance/surrogate-scope.json (the one
// definition both of its enforcers replay, ADR 0139 there). This adapter is a
// third reader of it, so it replays the same cases.
const scope: Scope = JSON.parse(
	readFileSync(join(here, "fixtures/surrogate-scope.json"), "utf8"),
);

const cue = readFileSync(
	join(here, "../data-models/adapter_opensesame.cue"),
	"utf8",
);

function record(overrides: JsonObject = {}) {
	return {
		locator: "hobo-token://vercel/deploy",
		connection: "conn://acme/vercel",
		provider: "vercel",
		env_name: "VERCEL_TOKEN",
		paths: ["/v9/projects", "/v13/deployments"],
		methods: ["GET", "POST"],
		projection: "legacy-token",
		...overrides,
	};
}

function document(...bindings: JsonObject[]): JsonValue {
	return { bindings };
}

function codeOf(run: () => JsonValue | readonly object[]): string {
	try {
		run();
	} catch (error) {
		if (error instanceof OpenSesameAdapterError) return error.code;
		throw error;
	}
	return "no error";
}

function messageOf(run: () => JsonValue | readonly object[]): string {
	try {
		run();
	} catch (error) {
		if (error instanceof Error) return error.message;
		throw error;
	}
	return "no error";
}

describe("parseCredentialBindings", () => {
	it("parses a bounded vercel binding into the record the CUE describes", () => {
		const [binding] = parseCredentialBindings(document(record()));
		expect(binding).toMatchObject({
			locator: "hobo-token://vercel/deploy",
			connection: "conn://acme/vercel",
			provider: "vercel",
			envName: "VERCEL_TOKEN",
			paths: ["/v9/projects", "/v13/deployments"],
			methods: ["GET", "POST"],
			projection: "legacy-token",
		});
	});

	it("rejects a binding without paths", () => {
		expect(
			codeOf(() => parseCredentialBindings(document(record({ paths: [] })))),
		).toBe("binding_invalid");
		const { paths: _omitted, ...withoutPaths } = record();
		expect(codeOf(() => parseCredentialBindings(document(withoutPaths)))).toBe(
			"binding_invalid",
		);
	});

	it("rejects a binding without methods", () => {
		expect(
			codeOf(() => parseCredentialBindings(document(record({ methods: [] })))),
		).toBe("binding_invalid");
	});

	it("rejects methods outside the closed set", () => {
		for (const method of [
			"HEAD",
			"OPTIONS",
			"CONNECT",
			"get",
			"GET,POST",
			"",
		]) {
			expect(
				codeOf(() =>
					parseCredentialBindings(document(record({ methods: [method] }))),
				),
				method,
			).toBe("binding_invalid");
		}
	});

	it("replays OpenSesame's method vectors: nothing it refuses is accepted here", () => {
		for (const method of scope.methods.invalid) {
			expect(
				codeOf(() =>
					parseCredentialBindings(document(record({ methods: [method] }))),
				),
				JSON.stringify(method),
			).toBe("binding_invalid");
		}
		// This adapter grants a narrower set than the plugin checks: the five
		// verbs HoBo's clients send. HEAD and OPTIONS are refused here on purpose.
		for (const method of scope.methods.valid) {
			const wanted = ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method);
			expect(
				codeOf(() =>
					parseCredentialBindings(document(record({ methods: [method] }))),
				),
				method,
			).toBe(wanted ? "no error" : "binding_invalid");
		}
	});

	it("replays OpenSesame's path vectors: every unbounded prefix is refused", () => {
		for (const path of scope.unbounded) {
			expect(
				codeOf(() =>
					parseCredentialBindings(document(record({ paths: [path] }))),
				),
				JSON.stringify(path),
			).toBe("binding_invalid");
		}
	});

	it("accepts every prefix OpenSesame calls bounded", () => {
		for (const path of scope.bounded) {
			expect(
				codeOf(() =>
					parseCredentialBindings(document(record({ paths: [path] }))),
				),
				path,
			).toBe("no error");
		}
	});

	it('refuses a path that would split or break out of paths="..."', () => {
		for (const path of ["/a,b", '/a"b', "/a b", "/a\nb", "/a#b", "/a'b"]) {
			expect(
				codeOf(() =>
					parseCredentialBindings(document(record({ paths: [path] }))),
				),
				JSON.stringify(path),
			).toBe("binding_invalid");
		}
	});

	it("rejects provider aws with provider_not_brokered and says what would change that", () => {
		const aws = record({
			provider: "aws",
			connection: "conn://acme/aws",
			locator: "hobo-token://aws/deploy",
			env_name: "AWS_SECRET_ACCESS_KEY",
		});
		expect(codeOf(() => parseCredentialBindings(document(aws)))).toBe(
			"provider_not_brokered",
		);
		const message = messageOf(() => parseCredentialBindings(document(aws)));
		expect(message).toMatch(/SigV4/);
		expect(message).toMatch(/STS/);
	});

	it("rejects any other provider as not brokered", () => {
		expect(
			codeOf(() =>
				parseCredentialBindings(
					document(
						record({ provider: "github", connection: "conn://acme/github" }),
					),
				),
			),
		).toBe("provider_not_brokered");
	});

	it("requires the connection's last segment to be the provider", () => {
		expect(
			codeOf(() =>
				parseCredentialBindings(
					document(record({ connection: "conn://acme/web" })),
				),
			),
		).toBe("binding_invalid");
	});

	it("accepts a project-scoped connection and refuses a version suffix", () => {
		expect(
			codeOf(() =>
				parseCredentialBindings(
					document(record({ connection: "conn://acme/web/vercel" })),
				),
			),
		).toBe("no error");
		expect(
			codeOf(() =>
				parseCredentialBindings(
					document(record({ connection: "conn://acme/vercel@v2" })),
				),
			),
		).toBe("binding_invalid");
	});

	it("rejects a locator that is not a registered hobo-token reference", () => {
		for (const locator of [
			"vault://vercel/deploy",
			"hobo-token://vercel",
			"hobo-token://Vercel/deploy",
			"hobo-token://vercel/deploy/extra",
			"hobo-token://vercel/deploy#field",
			"not a locator",
		]) {
			expect(
				codeOf(() => parseCredentialBindings(document(record({ locator })))),
				locator,
			).toBe("binding_invalid");
		}
	});

	it("rejects a variable name that is not an upper-case identifier", () => {
		for (const env_name of [
			"vercel_token",
			"1TOKEN",
			"VERCEL-TOKEN",
			"",
			"A B",
		]) {
			expect(
				codeOf(() => parseCredentialBindings(document(record({ env_name })))),
				env_name,
			).toBe("binding_invalid");
		}
	});

	// Names the run depends on: a surrogate placed in one of them switches the proxy
	// off, loops the relaunch, injects code or breaks the CA (review S3).
	const RESERVED = [
		"HOBO_OPENSESAME_CHILD",
		"NODE_USE_ENV_PROXY",
		"PATH",
		"NODE_OPTIONS",
		"OPENSESAME_STORE_PASSWORD",
		"LD_PRELOAD",
		"LD_LIBRARY_PATH",
		"DYLD_INSERT_LIBRARIES",
		"DYLD_LIBRARY_PATH",
		"NODE_PATH",
		"NODE_EXTRA_CA_CERTS",
		"HTTPS_PROXY",
		"HTTP_PROXY",
		"ALL_PROXY",
		"NO_PROXY",
		"SSL_CERT_FILE",
		"SSL_CERT_DIR",
		"HOME",
		"SHELL",
		"IFS",
		"OPENSESAME_ENV_PARSE",
		"NODE_ANYTHING",
		"LD_AUDIT",
		"DYLD_FALLBACK_LIBRARY_PATH",
	] as const;

	it.each(
		RESERVED,
	)("rejects the reserved variable %s with reserved_env_name", (name) => {
		expect(
			codeOf(() =>
				parseCredentialBindings(document(record({ env_name: name }))),
			),
		).toBe("reserved_env_name");
	});

	it("accepts names that only resemble a reserved one", () => {
		for (const name of [
			"VERCEL_TOKEN",
			"HOBO_VERCEL_TOKEN",
			"PATHS",
			"MY_PROXY_TOKEN",
			"NODEJS_TOKEN",
			"LDAP_TOKEN",
			"HOMEPAGE_TOKEN",
		]) {
			expect(
				codeOf(() =>
					parseCredentialBindings(document(record({ env_name: name }))),
				),
				name,
			).toBe("no error");
		}
	});

	it("rejects a projection other than legacy-token", () => {
		expect(
			codeOf(() =>
				parseCredentialBindings(
					document(record({ projection: "oauth-bearer" })),
				),
			),
		).toBe("binding_invalid");
	});

	it("rejects a field the record does not have, naming the field but never its value", () => {
		const leaked = "vtok_dummy_marker_0123456789abcdef";
		const run = () =>
			parseCredentialBindings(document(record({ token: leaked })));
		expect(codeOf(run)).toBe("binding_invalid");
		expect(messageOf(run)).toContain("token");
		expect(messageOf(run)).not.toContain(leaked);
	});

	it("never echoes a rejected value into the message", () => {
		const leaked = "vtok_dummy_marker_0123456789abcdef";
		for (const bad of [
			record({ connection: leaked }),
			record({ locator: leaked }),
			record({ env_name: leaked }),
			record({ paths: [leaked] }),
			record({ methods: [leaked] }),
			record({ provider: leaked }),
		]) {
			expect(
				messageOf(() => parseCredentialBindings(document(bad))),
			).not.toContain(leaked);
		}
	});

	it("rejects two bindings that share a locator or a variable", () => {
		expect(
			codeOf(() =>
				parseCredentialBindings(
					document(record(), record({ env_name: "OTHER_TOKEN" })),
				),
			),
		).toBe("binding_invalid");
		expect(
			codeOf(() =>
				parseCredentialBindings(
					document(record(), record({ locator: "hobo-token://vercel/other" })),
				),
			),
		).toBe("binding_invalid");
	});

	it("rejects a document that is not { bindings: [...] }", () => {
		for (const input of [
			null,
			"x",
			3,
			[],
			{},
			{ bindings: "x" },
			{ bindings: [3] },
		]) {
			expect(
				codeOf(() => parseCredentialBindings(input)),
				JSON.stringify(input),
			).toBe("binding_invalid");
		}
	});

	it("freezes the parsed bindings, their lists and the list of them", () => {
		const parsed = parseCredentialBindings(document(record()));
		const [binding] = parsed;
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(binding)).toBe(true);
		expect(Object.isFrozen(binding?.paths)).toBe(true);
		expect(Object.isFrozen(binding?.methods)).toBe(true);
	});

	it("copies its input: a later edit of the input does not move a parsed binding", () => {
		const input = record();
		const paths = input.paths;
		const parsed = parseCredentialBindings(document(input));
		if (Array.isArray(paths)) paths.push("/v2/user");
		expect(parsed[0]?.paths).toEqual(["/v9/projects", "/v13/deployments"]);
	});
});

describe("the parser and the CUE are one definition", () => {
	function cueRegexes(): string[] {
		const found: string[] = [];
		for (const match of cue.matchAll(/[=!]~("(?:[^"\\]|\\.)*")/gu)) {
			const literal = match[1];
			if (literal !== undefined) found.push(JSON.parse(literal));
		}
		return found;
	}

	it("every pattern the parser applies appears verbatim in adapter_opensesame.cue", () => {
		const regexes = cueRegexes();
		for (const pattern of [
			LOCATOR_PATTERN,
			CONNECTION_PATTERN,
			ENV_NAME_PATTERN,
			PATH_PATTERN,
			PATH_NO_EMPTY_SEGMENT_PATTERN,
			PATH_NO_DOT_SEGMENT_PATTERN,
			RESERVED_ENV_NAME_PATTERN,
		]) {
			expect(regexes, pattern).toContain(pattern);
		}
	});

	it("the CUE closes the provider and the projection to the values the parser accepts", () => {
		expect(cue).toMatch(/provider:\s*"vercel"/u);
		expect(cue).toMatch(/projection:\s*"legacy-token"/u);
		expect(cue).toMatch(
			/\[\.\.\."GET" \| "POST" \| "PUT" \| "PATCH" \| "DELETE"\]/u,
		);
	});
});
