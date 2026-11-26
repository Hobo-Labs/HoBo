/**
 * The Hostinger provider's local IaC-program check, `assertLocalIacProgram`:
 * the last gate between realize() and a program the engine would apply.
 *
 * **Unresolved output references must be caught at emit time.** An IaC program
 * whose `${resources.x.outputs.y}` names a resource that does not exist, or an
 * output that resource never declares, is a program the engine will fail to
 * apply halfway through — after it has already created whatever came first. The
 * check here is what makes that a rejected program instead of a partial deploy.
 *
 * Fixtures are typed programs. Only the cases that hand the guard a field the
 * type forbids build one through `documentProgram`, which is where the one
 * assertion lives.
 */
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

/** A program's fields as a document may carry them: the declared type, any other JSON, or absent. */
type ProgramFields = {
	readonly [field in keyof IacProgram]?:
		| IacProgram[field]
		| JsonValue
		| undefined;
};

/** A minimal program that passes every structural check; every field keeps its declared type. */
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

/** A program as it arrives across a document boundary, carrying a field the type forbids. */
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
		// The engine dispatches on this. A program claiming a version the engine
		// does not know is rejected there with a far less legible error than the
		// one that names the expected value.
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
		// An empty program applies cleanly and creates nothing, which reads to a
		// caller as a successful deploy of an empty deployment. Better refused
		// here than reported as a no-op success.
		expect(() => assertLocalIacProgram(program({ resources: [] }))).toThrow(
			/at least one resource/u,
		);
		expect(() =>
			assertLocalIacProgram(documentProgram({ resources: undefined })),
		).toThrow(/at least one resource/u);
	});

	it("refuses a resource with no name", () => {
		// Names are how references resolve and how the engine addresses state. An
		// unnamed resource cannot be referenced or updated on a second apply.
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
		// A duplicate makes every reference to that name ambiguous, and the engine
		// would silently bind to one of them. Which one is not something a plan
		// author should have to reason about.
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
		// The consequential check. The engine would fail applying this *after*
		// creating whatever came first, leaving a half-built deployment that has
		// to be reconciled by hand.
		expect(() =>
			assertLocalIacProgram(
				program({ stackOutputs: { url: "${resources.ghost.outputs.ipv4}" } }),
			),
		).toThrow(/unresolved output reference resources\.ghost\.outputs\.ipv4/u);
	});

	it("refuses a reference to an output the resource never declares", () => {
		// Same failure mode, one level deeper: the resource exists, the output
		// does not, and the reference resolves to nothing at apply time.
		expect(() =>
			assertLocalIacProgram(
				program({ stackOutputs: { url: "${resources.api.outputs.nope}" } }),
			),
		).toThrow(/unresolved output reference/u);
	});

	it("refuses a malformed reference rather than treating it as a literal", () => {
		// Anything starting `${resources.` was *meant* to be a reference. Passing
		// a typo through as a plain string would deploy the literal text
		// `${resources.api.outputs}` as a value.
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
		// `collectValues` walks the whole input tree. Checking only the top level
		// would miss the common case, since bind references live inside nested
		// `bindings` arrays.
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
