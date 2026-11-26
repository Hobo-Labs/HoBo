import { describe, expect, it } from "vitest";

import { validateIacProgram } from "../src/index.js";
import type { JsonObject, JsonValue } from "../src/json.js";

function resource(name: string, over: JsonObject = {}): JsonObject {
	return {
		name,
		type: "hobo:database/postgres",
		provider: "kubernetes",
		inputs: {
			compositionSelector: { matchLabels: { port: "database" } },
		},
		outputs: ["endpoint"],
		...over,
	};
}

function program(over: JsonObject = {}): JsonObject {
	return {
		apiVersion: "hobo.iac-program/v1",
		kind: "iac-program",
		provider: "crossplane",
		deploymentId: "dep-1",
		stack: "stack-1",
		resources: [resource("database")],
		stackOutputs: {},
		...over,
	};
}

function refusal(value: JsonValue): string {
	try {
		validateIacProgram(value);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "no-refusal";
}

describe("references inside resource inputs", () => {
	it("accepts a reference to an output its target declares", () => {
		expect(() =>
			validateIacProgram(
				program({
					resources: [
						resource("database"),
						resource("app", {
							inputs: {
								compositionSelector: { matchLabels: { port: "web" } },
								parameters: { dsn: "${resources.database.outputs.endpoint}" },
							},
						}),
					],
				}),
			),
		).not.toThrow();
	});

	it("refuses a reference to a resource that is not in the program", () => {
		expect(
			refusal(
				program({
					resources: [
						resource("app", {
							inputs: {
								compositionSelector: { matchLabels: { port: "web" } },
								parameters: { dsn: "${resources.cache.outputs.endpoint}" },
							},
						}),
					],
				}),
			),
		).toMatch(
			/unresolved output reference resources\.cache\.outputs\.endpoint/u,
		);
	});

	it("refuses a reference to an output its target does not declare", () => {
		expect(
			refusal(
				program({
					resources: [
						resource("database"),
						resource("app", {
							inputs: {
								compositionSelector: { matchLabels: { port: "web" } },
								parameters: { dsn: "${resources.database.outputs.password}" },
							},
						}),
					],
				}),
			),
		).toMatch(/resources\.database\.outputs\.password/u);
	});

	it("finds a reference nested deep inside the inputs", () => {
		expect(
			refusal(
				program({
					resources: [
						resource("app", {
							inputs: {
								compositionSelector: { matchLabels: { port: "web" } },
								connection: {
									pool: [{ dsn: "${resources.missing.outputs.endpoint}" }],
								},
							},
						}),
					],
				}),
			),
		).toMatch(/unresolved output reference/u);
	});

	it("refuses a malformed reference rather than passing it through", () => {
		expect(
			refusal(
				program({
					resources: [
						resource("app", {
							inputs: {
								compositionSelector: { matchLabels: { port: "web" } },
								parameters: { dsn: "${resources.database.endpoint}" },
							},
						}),
					],
				}),
			),
		).toMatch(/invalid output reference/u);
	});

	it("leaves ordinary strings alone, dollar signs included", () => {
		expect(() =>
			validateIacProgram(
				program({
					resources: [
						resource("app", {
							inputs: {
								compositionSelector: { matchLabels: { port: "web" } },
								parameters: { shell: "${HOME}/data", price: "$5" },
							},
						}),
					],
				}),
			),
		).not.toThrow();
	});

	it("still validates stackOutputs by the same rule", () => {
		expect(
			refusal(
				program({
					stackOutputs: { url: "${resources.database.outputs.missing}" },
				}),
			),
		).toMatch(/unresolved output reference/u);
	});
});
