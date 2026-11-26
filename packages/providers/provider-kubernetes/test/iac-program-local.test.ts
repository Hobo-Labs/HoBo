/**
 * The Kubernetes provider's local IaC-program check, `assertLocalIacProgram`:
 * the last gate between realize() and a program the engine would apply.
 *
 * **Unresolved output references are caught at emit time.** A program whose
 * `${resources.x.outputs.y}` names a resource that does not exist is one the
 * engine fails to apply halfway through — after it has created whatever came
 * first. Rejecting it here makes that a refused program rather than a partial
 * deploy somebody has to reconcile by hand.
 *
 * Fixtures are typed programs. Only the cases that hand the guard a field the
 * type forbids build one through `documentProgram`, which is where the one
 * assertion lives.
 */
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

/** A program's fields as a document may carry them: the declared type, any other JSON, or absent. */
type ProgramFields = {
	readonly [field in keyof IacProgram]?:
		| IacProgram[field]
		| JsonValue
		| undefined;
};

/** A well-formed program: every fixture field keeps its declared type. */
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

	it("refuses a wrong schema version, kind, or IaC lane", () => {
		// The engine dispatches on all three. A program claiming a combination it
		// does not know is rejected there with a far less legible error.
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
		// An empty program applies cleanly and creates nothing — a deploy that
		// reports success and deploys nothing.
		expect(() => assertLocalIacProgram(program({ resources: [] }))).toThrow(
			/at least one resource/u,
		);
		expect(() =>
			assertLocalIacProgram(documentProgram({ resources: undefined })),
		).toThrow(/at least one resource/u);
	});

	it("refuses an unnamed resource", () => {
		// Names are how references resolve and how the engine addresses state
		// across applies. An unnamed resource cannot be updated on a second run.
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
		// A duplicate makes every reference to that name ambiguous, and which one
		// the engine binds to is not something a plan author should reason about.
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
		// Both fail at apply time, after earlier resources have been created.
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
		// Anything starting `${resources.` was meant to be a reference. Passing a
		// typo through would set an environment variable to the literal text.
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
		// Bind references live inside nested `bindings` arrays, so a top-level-only
		// walk would miss the common case entirely.
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
