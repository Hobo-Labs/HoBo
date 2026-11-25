import { describe, expect, it } from "vitest";

import {
	assertLocalIacProgram,
	IAC_PROGRAM_API_VERSION,
	IAC_PROGRAM_KIND,
	IAC_PROVIDER,
	type IacProgram,
	KUBERNETES_IAC_PROVIDER,
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
		stack: "kubernetes/d-1",
		resources: [
			{
				name: "api",
				type: "kubernetes:deployment",
				provider: KUBERNETES_IAC_PROVIDER,
				inputs: {},
				outputs: ["binding", "clusterIP"],
			},
		],
		stackOutputs: {},
		...overrides,
	};
}

function documentProgram(overrides: ProgramFields): IacProgram {
	const document = { ...program(), ...overrides };
	return document as IacProgram;
}

describe("assertLocalIacProgram", () => {
	it("returns a well-formed program unchanged", () => {
		const input = program();
		expect(assertLocalIacProgram(input)).toBe(input);
	});

	it("refuses a wrong schema version, kind, or IaC lane", () => {
		expect(() =>
			assertLocalIacProgram(documentProgram({ apiVersion: "v2" })),
		).toThrow(/apiVersion must be/u);
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

	it("refuses an unnamed resource", () => {
		expect(() =>
			assertLocalIacProgram(
				program({
					resources: [
						{
							name: "",
							type: "kubernetes:deployment",
							provider: KUBERNETES_IAC_PROVIDER,
							inputs: {},
							outputs: [],
						},
					],
				}),
			),
		).toThrow(/missing name/u);
	});

	it("refuses two resources sharing a name", () => {
		const resource = {
			name: "api",
			type: "kubernetes:deployment",
			provider: KUBERNETES_IAC_PROVIDER,
			inputs: {},
			outputs: [],
		};
		expect(() =>
			assertLocalIacProgram(
				program({ resources: [resource, { ...resource }] }),
			),
		).toThrow(/duplicate resource api/u);
	});

	it("accepts a reference to a declared output", () => {
		expect(() =>
			assertLocalIacProgram(
				program({ stackOutputs: { ip: "${resources.api.outputs.clusterIP}" } }),
			),
		).not.toThrow();
	});

	it("refuses a reference to a resource or output that does not exist", () => {
		for (const value of [
			"${resources.ghost.outputs.clusterIP}",
			"${resources.api.outputs.nope}",
		]) {
			expect(() =>
				assertLocalIacProgram(program({ stackOutputs: { ip: value } })),
			).toThrow(/unresolved output reference/u);
		}
	});

	it("refuses a malformed reference rather than deploying it as a literal", () => {
		for (const value of [
			"${resources.api.outputs}",
			"${resources..outputs.x}",
			"${resources.api.outputs.x} trailing",
		]) {
			expect(() =>
				assertLocalIacProgram(program({ stackOutputs: { ip: value } })),
			).toThrow(/invalid output reference/u);
		}
	});

	it("leaves a value that is not trying to be a reference alone", () => {
		expect(() =>
			assertLocalIacProgram(
				program({ stackOutputs: { note: "costs $5 ${notaref}" } }),
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
							type: "kubernetes:deployment",
							provider: KUBERNETES_IAC_PROVIDER,
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
