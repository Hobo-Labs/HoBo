import { describe, expect, it } from "vitest";

import {
	assertLocalIacProgram,
	HOSTINGER_IAC_PROVIDER,
	IAC_PROGRAM_API_VERSION,
	IAC_PROGRAM_KIND,
	IAC_PROVIDER,
	type IacProgram,
} from "../src/iac-program.js";
import type { JsonValue } from "../src/json.js";

type ProgramFields = {
	readonly [field in keyof IacProgram]?:
		| IacProgram[field]
		| JsonValue
		| undefined;
};

function program(overrides: Partial<IacProgram> = {}): IacProgram {
	return {
		apiVersion: IAC_PROGRAM_API_VERSION,
		kind: IAC_PROGRAM_KIND,
		provider: IAC_PROVIDER,
		deploymentId: "d-1",
		stack: "hostinger/d-1",
		resources: [
			{
				name: "api",
				type: "hostinger:vps",
				provider: HOSTINGER_IAC_PROVIDER,
				inputs: {},
				outputs: ["ipv4", "binding"],
			},
		],
		stackOutputs: {},
		...overrides,
	};
}

function documentProgram(overrides: ProgramFields): IacProgram {
	const document = { ...program(), ...overrides };
	// SAFETY: the guard is the parse boundary for programs that crossed a
	// document boundary, so these cases hand it what the type forbids (a
	// foreign version, no resource list). It re-checks every field it relies on
	// before trusting the declared type.
	return document as IacProgram;
}

describe("assertLocalIacProgram", () => {
	it("returns a well-formed program unchanged", () => {
		const input = program();
		expect(assertLocalIacProgram(input)).toBe(input);
	});

	it("refuses a program stamped with the wrong schema version", () => {
		expect(() =>
			assertLocalIacProgram(
				documentProgram({ apiVersion: "hobo.iac-program/v2" }),
			),
		).toThrow(/apiVersion must be/u);
	});

	it("refuses a program with the wrong kind or IaC lane", () => {
		expect(() =>
			assertLocalIacProgram(documentProgram({ kind: "stack" })),
		).toThrow(/kind must be iac-program/u);
		expect(() =>
			assertLocalIacProgram(documentProgram({ provider: "terraform" })),
		).toThrow(/provider must be pulumi/u);
	});

	it("refuses a program with no resources at all", () => {
		expect(() => assertLocalIacProgram(program({ resources: [] }))).toThrow(
			/at least one resource/u,
		);
		expect(() =>
			assertLocalIacProgram(documentProgram({ resources: undefined })),
		).toThrow(/at least one resource/u);
	});

	it("refuses a resource with no name", () => {
		expect(() =>
			assertLocalIacProgram(
				program({
					resources: [
						{
							name: "",
							type: "hostinger:vps",
							provider: HOSTINGER_IAC_PROVIDER,
							inputs: {},
							outputs: [],
						},
					],
				}),
			),
		).toThrow(/missing name/u);
	});

	it("refuses two resources sharing a name", () => {
		expect(() =>
			assertLocalIacProgram(
				program({
					resources: [
						{
							name: "api",
							type: "hostinger:vps",
							provider: HOSTINGER_IAC_PROVIDER,
							inputs: {},
							outputs: [],
						},
						{
							name: "api",
							type: "hostinger:mysql-database",
							provider: HOSTINGER_IAC_PROVIDER,
							inputs: {},
							outputs: [],
						},
					],
				}),
			),
		).toThrow(/duplicate resource api/u);
	});

	it("accepts a reference to a declared output", () => {
		expect(() =>
			assertLocalIacProgram(
				program({ stackOutputs: { url: "${resources.api.outputs.ipv4}" } }),
			),
		).not.toThrow();
	});

	it("refuses a reference to a resource that does not exist", () => {
		expect(() =>
			assertLocalIacProgram(
				program({ stackOutputs: { url: "${resources.ghost.outputs.ipv4}" } }),
			),
		).toThrow(/unresolved output reference resources\.ghost\.outputs\.ipv4/u);
	});

	it("refuses a reference to an output the resource never declares", () => {
		expect(() =>
			assertLocalIacProgram(
				program({ stackOutputs: { url: "${resources.api.outputs.nope}" } }),
			),
		).toThrow(/unresolved output reference/u);
	});

	it("refuses a malformed reference rather than treating it as a literal", () => {
		for (const value of [
			"${resources.api.outputs}",
			"${resources..outputs.x}",
			"${resources.api.output.x}",
			"${resources.api.outputs.x} trailing",
		]) {
			expect(() =>
				assertLocalIacProgram(program({ stackOutputs: { url: value } })),
			).toThrow(/invalid output reference/u);
		}
	});

	it("leaves a string that is not trying to be a reference alone", () => {
		// The `startsWith` early return. Ordinary values — hostnames, regions,
		// even a `$` in a password — must not be parsed as references.
		expect(() =>
			assertLocalIacProgram(
				program({ stackOutputs: { note: "cost is $5 ${notaref}" } }),
			),
		).not.toThrow();
	});

	it("checks references nested anywhere inside a resource's inputs", () => {
		expect(() =>
			assertLocalIacProgram(
				program({
					resources: [
						{
							name: "api",
							type: "hostinger:vps",
							provider: HOSTINGER_IAC_PROVIDER,
							inputs: {
								bindings: [{ ref: "${resources.ghost.outputs.binding}" }],
							},
							outputs: ["binding"],
						},
					],
				}),
			),
		).toThrow(/unresolved output reference/u);
	});
});
