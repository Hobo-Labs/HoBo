import { readFileSync } from "node:fs";
import { toJson } from "@bufbuild/protobuf";
import { DesiredCiPolicySchema } from "@hobo/ci";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	ciEnvironmentPolicySha256,
	parseCiProjectConfig,
	selectCiEnvironment,
} from "../src/project-config.js";
import { ciProjectJsonSchema } from "../src/project-schema.js";

const examplePath = new URL("../examples/project/ci.json", import.meta.url);
function source() {
	return JSON.parse(readFileSync(examplePath, "utf8"));
}

describe("typed project component references", () => {
	it("keeps generated scope-name patterns correct without JavaScript-only regex flags", () => {
		const schema = z
			.object({
				$defs: z.record(
					z.string(),
					z.object({ pattern: z.string().optional() }).passthrough(),
				),
			})
			.parse(ciProjectJsonSchema());
		const pattern = Object.values(schema.$defs)
			.map((entry) => entry.pattern)
			.find(
				(entry) =>
					entry !== undefined &&
					new RegExp(entry, "u").test("tenant-😀") &&
					!new RegExp(entry, "u").test("tenant\u0001"),
			);
		if (!pattern)
			throw new Error(
				"scope identifier pattern is missing from the editor schema",
			);
		const portable = new RegExp(pattern);
		expect(portable.test("acme")).toBe(true);
		expect(portable.test("tenant-😀")).toBe(true);
		for (const code of [0, 1, 31, 127, 128, 159])
			expect(portable.test(`tenant${String.fromCharCode(code)}`)).toBe(false);
	});
	it("ships the exact schema generated from the runtime authoring contract", () => {
		expect(
			JSON.parse(
				readFileSync(
					new URL("../schema/ci-project.schema.json", import.meta.url),
					"utf8",
				),
			),
		).toEqual(ciProjectJsonSchema());
	});
	it("expands independent component references with the same digest as inline intent", async () => {
		const input = source();
		const config = parseCiProjectConfig(JSON.stringify(input));
		const selected = selectCiEnvironment(config, "local");
		expect(selected.policy.pool).toMatchObject({
			label: "hobo",
			os: "linux",
			architecture: "x64",
		});
		const inline = {
			defaultEnvironment: "local",
			environments: {
				local: {
					relayOrigin: selected.relayOrigin,
					allowInsecureLoopback: true,
					policy: toJson(DesiredCiPolicySchema, selected.policy),
				},
			},
		};
		expect(await ciEnvironmentPolicySha256(config, "local")).toBe(
			await ciEnvironmentPolicySha256(
				parseCiProjectConfig(JSON.stringify(inline)),
				"local",
			),
		);
	});
	it.each([
		{ $ref: "#/definitions/routing/free-first" },
		{ $ref: "#/definitions/pools/missing" },
		{ $ref: "https://attacker.example/pool.json" },
		{ $ref: "file:///run/secrets/value" },
		{ $ref: "#/definitions/pools/linux", label: "hobo" },
	])("rejects wrong, missing, external and ambiguous pool references", (pool) => {
		const input = source();
		input.environments.local.policy.pool = pool;
		expect(() => parseCiProjectConfig(JSON.stringify(input))).toThrow(
			"invalid CI project configuration",
		);
	});
	it("validates unused definitions and forbids reference chains", () => {
		const input = source();
		input.definitions.pools.invalid = { $ref: "#/definitions/pools/linux" };
		expect(() => parseCiProjectConfig(JSON.stringify(input))).toThrow();
		input.definitions.pools.invalid = {
			label: "hobo",
			os: "windows",
			architecture: "x64",
		};
		expect(() => parseCiProjectConfig(JSON.stringify(input))).toThrow();
	});
	it("rejects duplicate phases in unused declarations and recursive hobo providers", () => {
		const input = source();
		input.definitions.secrets.invalid = {
			TOKEN: { requiredFor: ["execution", "execution"] },
		};
		expect(() => parseCiProjectConfig(JSON.stringify(input))).toThrow();
		delete input.definitions.secrets.invalid;
		input.definitions.providers.invalid = {
			id: "bad",
			kind: "github",
			connectionRef: "bad",
			runsOn: "HoBo",
		};
		expect(() => parseCiProjectConfig(JSON.stringify(input))).toThrow();
	});
});
