import { describe, expect, it } from "vitest";

import {
	assertLocalIacProgram,
	IAC_PROGRAM_API_VERSION,
	IAC_PROGRAM_KIND,
	IAC_PROVIDER,
} from "../src/iac-program.js";
import type { JsonObject, JsonValue } from "../src/json.js";

type Program = Parameters<typeof assertLocalIacProgram>[0];
type Resource = Program["resources"][number];

type ProgramFields = {
	readonly [field in keyof Program]?: Program[field] | JsonValue;
};

function resource(over: Partial<Resource> = {}): Resource {
	return {
		name: "db",
		type: "provider:resource",
		provider: "provider",
		inputs: {},
		outputs: ["endpoint"],
		...over,
	};
}

function program(over: Partial<Program> = {}): Program {
	return {
		apiVersion: IAC_PROGRAM_API_VERSION,
		kind: IAC_PROGRAM_KIND,
		provider: IAC_PROVIDER,
		deploymentId: "dep-1",
		stack: "stack-1",
		resources: [resource()],
		stackOutputs: {},
		...over,
	};
}

function documentProgram(over: ProgramFields): Program {
	const document = { ...program(), ...over };
	return document as Program;
}

function refusal(value: Program): string {
	try {
		assertLocalIacProgram(value);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "no-refusal";
}

describe("the program header", () => {
	it("accepts a minimal well-formed program", () => {
		expect(() => assertLocalIacProgram(program())).not.toThrow();
	});

	it("returns the program so it can be used as a parse step", () => {
		const value = program();
		expect(assertLocalIacProgram(value)).toBe(value);
	});

	it("refuses an apiVersion it does not mirror", () => {
		expect(
			refusal(documentProgram({ apiVersion: "hobo.iac-program/v0" })),
		).toMatch(/apiVersion/u);
	});

	it("refuses a kind that is not a program", () => {
		expect(refusal(documentProgram({ kind: "iac-stack" }))).toMatch(/kind/u);
	});

	it("refuses a program targeting another IaC lane", () => {
		expect(refusal(documentProgram({ provider: "terraform" }))).toMatch(
			/provider/u,
		);
	});
});

describe("the resource list", () => {
	it("refuses a program that declares no resources", () => {
		expect(refusal(program({ resources: [] }))).toMatch(/at least one/u);
	});

	it("refuses a resource list that is not a list", () => {
		expect(refusal(documentProgram({ resources: {} }))).toMatch(
			/at least one/u,
		);
	});

	it("refuses a resource with no name", () => {
		expect(refusal(program({ resources: [resource({ name: "" })] }))).toMatch(
			/missing name/u,
		);
	});

	it("refuses two resources sharing a name", () => {
		expect(
			refusal(
				program({ resources: [resource(), resource({ type: "other" })] }),
			),
		).toMatch(/duplicate resource db/u);
	});
});

describe("output references", () => {
	const withInputs = (inputs: JsonObject, outs: Program["stackOutputs"] = {}) =>
		program({
			resources: [resource({ inputs })],
			stackOutputs: outs,
		});

	it("accepts a reference to an output the resource declares", () => {
		expect(() =>
			assertLocalIacProgram(
				withInputs({ url: "${resources.db.outputs.endpoint}" }),
			),
		).not.toThrow();
	});

	it("finds a reference nested deep inside resource inputs", () => {
		expect(
			refusal(
				withInputs({
					connection: { primary: [{ dsn: "${resources.db.outputs.nope}" }] },
				}),
			),
		).toMatch(/unresolved output reference/u);
	});

	it("refuses a reference to a resource that is not in the program", () => {
		expect(
			refusal(withInputs({ url: "${resources.cache.outputs.endpoint}" })),
		).toMatch(/resources\.cache\.outputs\.endpoint/u);
	});

	it("refuses a reference to an output the resource does not declare", () => {
		expect(
			refusal(withInputs({ url: "${resources.db.outputs.password}" })),
		).toMatch(/resources\.db\.outputs\.password/u);
	});

	it("refuses a malformed reference rather than ignoring it", () => {
		expect(refusal(withInputs({ url: "${resources.db.endpoint}" }))).toMatch(
			/invalid output reference/u,
		);
	});

	it("leaves a string that is not a reference alone", () => {
		expect(() =>
			assertLocalIacProgram(
				withInputs({ region: "eu-west-1", shell: "${HOME}/data", price: "$5" }),
			),
		).not.toThrow();
	});

	it("checks stack outputs by the same rule", () => {
		expect(
			refusal(withInputs({}, { url: "${resources.db.outputs.missing}" })),
		).toMatch(/unresolved output reference/u);
		expect(() =>
			assertLocalIacProgram(
				withInputs({}, { url: "${resources.db.outputs.endpoint}" }),
			),
		).not.toThrow();
	});
});
