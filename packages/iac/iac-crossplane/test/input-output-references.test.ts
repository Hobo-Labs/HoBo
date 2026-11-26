/**
 * Output references inside resource inputs, validated at the parse boundary.
 *
 * Crossplane claims reference each other through their *inputs* —
 * `resolveValue` substitutes `${resources.<name>.outputs.<key>}` at apply
 * time — yet `validateIacProgram` only checked `stackOutputs`. A claim
 * referencing a resource that is not in the program, or an output its target
 * does not declare, parsed cleanly and then failed at resolve, deep inside the
 * apply: after CRD checks, after the cluster connection, a long way from the
 * program that expressed the bad reference.
 *
 * The same defect appeared twice already in this repo — `collectValues` with
 * no array branch, called on `program.resources`, which is an array — so the
 * first test pins the array traversal itself: a reference nested inside a
 * resource's inputs must be *seen*, not silently skipped.
 */
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

/** The message of the refusal, or a marker when there was none. */
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
		// The easier mistake to make: the resource exists, so the name looks
		// right, but nothing will ever populate that key at resolve time.
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
		// Where resolvers actually put them. A walk that only looked at
		// top-level input values would pass every realistic broken program.
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
		// It starts with `${resources.` so it was clearly meant to be one;
		// shipping it as a literal would hand the placeholder text to a claim.
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
		// The half that was already covered must stay covered.
		expect(
			refusal(
				program({
					stackOutputs: { url: "${resources.database.outputs.missing}" },
				}),
			),
		).toMatch(/unresolved output reference/u);
	});
});
