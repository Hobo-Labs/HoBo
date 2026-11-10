import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	parseProviderManifest,
	parseProviderManifestJson,
} from "../src/index.js";
import { at, EXAMPLE_TEXT, example, exampleJson } from "./support/example.js";

const FIXTURES = fileURLToPath(
	new URL("../data-models/fixtures", import.meta.url),
);

function fixtures(kind: "valid" | "invalid"): [string, JsonValue][] {
	return readdirSync(join(FIXTURES, kind)).map((name) => [
		name,
		JSON.parse(readFileSync(join(FIXTURES, kind, name), "utf8")),
	]);
}

function issuesOf(value: JsonValue): string[] {
	const result = parseProviderManifestJson(value);
	return result.ok ? [] : result.issues.map((i) => `${i.path}: ${i.message}`);
}

describe("parseProviderManifest", () => {
	it("parses the example manifest", () => {
		const manifest = example();
		expect(manifest.provider?.id).toBe("acme-cloud");
		expect(manifest.auth?.flows.map((flow) => flow.flow.case)).toEqual([
			"oauth2",
			"oauth2",
			"authMd",
			"oidcFederation",
			"apiKey",
		]);
		expect(manifest.billing?.products.map((product) => product.kind)).toEqual([
			"hardware",
			"service",
			"ai",
			"material",
		]);
	});

	it("keeps unquoted YAML decimals exactly as written", () => {
		const manifest = example();
		const reservation = manifest.billing?.products[0]?.plans[1]?.charges[0];
		// `amount: 900.00` — a float decode would yield "900".
		expect(
			reservation?.model.case === "recurring" && reservation.model.value.amount,
		).toBe("900.00");
		expect(manifest.auth?.tokenLifetimeSec).toBe(3600);
	});

	it("accepts the same document as JSON", () => {
		const result = parseProviderManifest(JSON.stringify(exampleJson()), "json");
		expect(result.ok).toBe(true);
	});

	it("reports malformed YAML and malformed JSON as issues", () => {
		expect(parseProviderManifest("a: [unterminated").ok).toBe(false);
		expect(parseProviderManifest("{not json", "json").ok).toBe(false);
	});

	it("refuses an unknown field rather than ignoring a typo", () => {
		const doc = exampleJson();
		at(doc, "billing").curency = "USD";
		expect(issuesOf(doc).join()).toContain("curency");
	});

	it("reports every issue in one pass", () => {
		const doc = exampleJson();
		at(doc, "provider").id = "Acme Cloud";
		at(doc, "billing").currency = "dollars";
		const issues = issuesOf(doc);
		expect(issues.some((i) => i.startsWith("provider.id:"))).toBe(true);
		expect(issues.some((i) => i.startsWith("billing.currency:"))).toBe(true);
	});

	it.each(fixtures("valid"))("accepts valid fixture %s", (_name, doc) => {
		expect(issuesOf(doc)).toEqual([]);
	});

	// The CUE gate and the runtime parser must agree on the same corpus.
	it.each(fixtures("invalid"))("refuses invalid fixture %s", (_name, doc) => {
		expect(issuesOf(doc)).not.toEqual([]);
	});
});

describe("refusals", () => {
	const cases: [
		string,
		(doc: ReturnType<typeof exampleJson>) => void,
		string,
	][] = [
		[
			"no section at all",
			(doc) => {
				delete doc.auth;
				delete doc.capabilities;
				delete doc.billing;
				delete doc.api;
			},
			"needs at least one of auth, capabilities, billing, api",
		],
		[
			"wrong schema id",
			(doc) => {
				doc.schema = "hobo.provider-manifest/v2";
			},
			"schema: must be hobo.provider-manifest/v1",
		],
		[
			"duplicate flow id",
			(doc) => {
				at(doc, "auth", "flows", 1).id = "console-oauth";
			},
			'auth.flows: id "console-oauth" is declared twice',
		],
		[
			"flow with no variant",
			(doc) => {
				delete at(doc, "auth", "flows", 4).apiKey;
			},
			"auth.flows[4]: must declare exactly one of",
		],
		[
			"PKCE downgrade",
			(doc) => {
				at(doc, "auth", "flows", 0, "oauth2").pkce = "plain";
			},
			"auth.flows[0].oauth2.pkce: must be one of S256",
		],
		[
			"OAuth flow nobody can reach",
			(doc) => {
				delete at(doc, "auth", "flows", 0, "oauth2").metadataUrl;
			},
			"auth.flows[0].oauth2: needs tokenEndpoint or metadataUrl",
		],
		[
			"device flow without its endpoint",
			(doc) => {
				delete at(doc, "auth", "flows", 1, "oauth2")
					.deviceAuthorizationEndpoint;
			},
			"device-code needs deviceAuthorizationEndpoint",
		],
		[
			"extension flow without the x- prefix",
			(doc) => {
				delete at(doc, "auth", "flows", 4).apiKey;
				at(doc, "auth", "flows", 4).extension = { type: "saml" };
			},
			'an extension type starting with "x-"',
		],
		[
			"token lifetime out of range",
			(doc) => {
				at(doc, "auth").tokenLifetimeSec = 90000;
			},
			"auth.tokenLifetimeSec: must be between 1 and 86400",
		],
		[
			"mapping to an undeclared product",
			(doc) => {
				at(doc, "capabilities", "mappings", 0).products = ["gpu-z9"];
			},
			'references unknown billing product "gpu-z9"',
		],
		[
			"malformed capability profile id",
			(doc) => {
				at(doc, "capabilities", "mappings", 1).profiles = ["postgres"];
			},
			"capabilities.mappings[1].profiles[0]:",
		],
		[
			"mapping with no regions anywhere",
			(doc) => {
				delete at(doc, "capabilities").regions;
			},
			"capabilities.mappings[0].regions: needs regions",
		],
		[
			"charge on an undeclared billable",
			(doc) => {
				at(
					doc,
					"billing",
					"products",
					0,
					"plans",
					0,
					"charges",
					0,
					"metered",
				).billable = "gpu-minutes";
			},
			'references unknown billable "gpu-minutes"',
		],
		[
			"recurring charge per an undeclared billable",
			(doc) => {
				at(
					doc,
					"billing",
					"products",
					0,
					"plans",
					1,
					"charges",
					0,
					"recurring",
				).per = "rack";
			},
			'recurring.per: references unknown billable "rack"',
		],
		[
			"tiers out of order",
			(doc) => {
				at(
					doc,
					"billing",
					"products",
					1,
					"plans",
					0,
					"charges",
					1,
					"metered",
					"graduated",
					"tiers",
					1,
				).upTo = "5";
			},
			"tiers must ascend",
		],
		[
			"closed last tier",
			(doc) => {
				at(
					doc,
					"billing",
					"products",
					1,
					"plans",
					0,
					"charges",
					1,
					"metered",
					"graduated",
					"tiers",
					2,
				).upTo = "9000";
			},
			"the last tier must be open-ended",
		],
		[
			"pro-rata package with no exact per-unit price",
			(doc) => {
				at(
					doc,
					"billing",
					"products",
					0,
					"plans",
					0,
					"charges",
					0,
					"metered",
					"package",
				).per = "7";
			},
			"amount / per is not an exact decimal",
		],
		[
			"float-formatted money",
			(doc) => {
				at(
					doc,
					"billing",
					"products",
					2,
					"plans",
					1,
					"charges",
					0,
					"metered",
				).unitPrice = "4e-1";
			},
			"must be a non-negative decimal string",
		],
		[
			"product that sells nothing",
			(doc) => {
				delete at(doc, "billing", "products", 1).billables;
				at(doc, "billing", "products", 1, "plans", 0).charges = [
					{ id: "base", recurring: { interval: "monthly", amount: "25" } },
				];
			},
			"a product whose charges name no billable must list at least one",
		],
		[
			"API spec with both a URL and a path",
			(doc) => {
				at(doc, "api", "specs", 0).url = "https://x.example.com/api.json";
			},
			"api.specs[0]: must declare exactly one of url, path",
		],
		[
			"API spec path that leaves the manifest directory",
			(doc) => {
				at(doc, "api", "specs", 0).path = "../../etc/openapi.yaml";
			},
			"must be a relative path inside the manifest's directory",
		],
		[
			"API spec in an unknown format",
			(doc) => {
				at(doc, "api", "specs", 1).format = "raml";
			},
			"api.specs[1].format: must be one of openapi",
		],
		[
			"API spec bound to an undeclared auth flow",
			(doc) => {
				at(doc, "api", "specs", 0).auth = ["nope"];
			},
			'api.specs[0].auth[0]: references unknown auth flow "nope"',
		],
		[
			"MCP server over plain HTTP",
			(doc) => {
				at(doc, "api").mcpServers = [
					{ id: "remote", url: "http://mcp.example.com" },
				];
			},
			"api.mcpServers[0].url: must be an https URL",
		],
		[
			"empty api section",
			(doc) => {
				doc.api = {};
			},
			"api: needs at least one spec or MCP server",
		],
		[
			"effective window that ends before it starts",
			(doc) => {
				at(doc, "billing").effectiveUntil = "2026-01-01T00:00:00Z";
			},
			"billing.effectiveUntil: must be after effectiveFrom",
		],
	];

	it.each(cases)("refuses %s", (_name, mutate, fragment) => {
		const doc = exampleJson();
		mutate(doc);
		expect(issuesOf(doc).join("\n")).toContain(fragment);
	});

	it("starts from a document with no issues", () => {
		expect(issuesOf(exampleJson())).toEqual([]);
		expect(EXAMPLE_TEXT).toContain("hobo.provider-manifest/v1");
	});
});
