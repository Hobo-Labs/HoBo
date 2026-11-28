import { describe, expect, it } from "vitest";

import {
	assertDriverProgram,
	CONVEX_DRIVER,
	DRIVER_PROGRAM_API_VERSION,
	DRIVER_PROGRAM_KIND,
	type DriverProgram,
} from "../src/driver-program.js";

const program = (overrides: Partial<DriverProgram> = {}): DriverProgram => ({
	apiVersion: DRIVER_PROGRAM_API_VERSION,
	kind: DRIVER_PROGRAM_KIND,
	driver: CONVEX_DRIVER,
	deploymentId: "d1",
	deployment: "bold-hyena-681",
	resources: [
		{
			name: "backend",
			type: "convex:deployment",
			provider: "convex",
			inputs: {},
			outputs: ["url", "binding"],
		},
	],
	outputs: { endpoint: "${resources.backend.outputs.url}" },
	...overrides,
});

describe("the pinned contract fields", () => {
	it("accepts a well-formed program", () => {
		expect(assertDriverProgram(program())).toBeTruthy();
	});

	it("refuses a wrong apiVersion, naming the expected value", () => {
		expect(() =>
			assertDriverProgram(program({ apiVersion: "v2" } as never)),
		).toThrow(new RegExp(DRIVER_PROGRAM_API_VERSION));
	});

	it("refuses a wrong kind", () => {
		expect(() =>
			assertDriverProgram(program({ kind: "iac-program" } as never)),
		).toThrow(/kind must be driver-program/);
	});

	it("refuses a wrong driver", () => {
		expect(() =>
			assertDriverProgram(program({ driver: "terraform" } as never)),
		).toThrow(new RegExp(CONVEX_DRIVER));
	});

	it("requires a named Convex deployment", () => {
		// The deployment slug is where the program provisions *into*. Without it
		// the call has no target, and Convex would apply it to whichever
		// deployment the ambient credential happens to reach.
		for (const deployment of ["", undefined, null]) {
			expect(
				() => assertDriverProgram(program({ deployment } as never)),
				String(deployment),
			).toThrow(/must name a Convex deployment/);
		}
	});
});

describe("resources", () => {
	it("requires at least one", () => {
		expect(() => assertDriverProgram(program({ resources: [] }))).toThrow(
			/at least one resource/,
		);
		expect(() =>
			assertDriverProgram(program({ resources: undefined as never })),
		).toThrow(/at least one resource/);
		expect(() =>
			assertDriverProgram(program({ resources: "backend" as never })),
		).toThrow(/at least one resource/);
	});

	it("refuses a resource with no name", () => {
		expect(() =>
			assertDriverProgram(
				program({
					resources: [{ ...program().resources[0], name: "" } as never],
					outputs: {},
				}),
			),
		).toThrow(/missing name/);
	});

	it("refuses duplicate names, quoting the collision", () => {
		expect(() =>
			assertDriverProgram(
				program({
					resources: [
						program().resources[0] as never,
						program().resources[0] as never,
					],
				}),
			),
		).toThrow(/duplicate resource backend/);
	});

	it("accepts several distinctly-named resources", () => {
		expect(() =>
			assertDriverProgram(
				program({
					resources: [
						program().resources[0] as never,
						{
							name: "storage",
							type: "convex:file-storage",
							provider: "convex",
							inputs: {},
							outputs: ["binding"],
						},
					],
					outputs: {
						endpoint: "${resources.backend.outputs.url}",
						files: "${resources.storage.outputs.binding}",
					},
				}),
			),
		).not.toThrow();
	});
});

describe("output references", () => {
	it("resolves a reference to a declared field", () => {
		expect(() =>
			assertDriverProgram(
				program({ outputs: { b: "${resources.backend.outputs.binding}" } }),
			),
		).not.toThrow();
	});

	it("refuses a reference to a resource the program does not contain", () => {
		expect(() =>
			assertDriverProgram(
				program({ outputs: { e: "${resources.gone.outputs.url}" } }),
			),
		).toThrow(/unresolved output reference/);
	});

	it("refuses a reference to a field the resource does not declare", () => {
		expect(() =>
			assertDriverProgram(
				program({ outputs: { e: "${resources.backend.outputs.nope}" } }),
			),
		).toThrow(/unresolved output reference/);
	});

	it("refuses a malformed template that still claims to be a reference", () => {
		for (const value of [
			"${resources.backend.outputs}",
			"${resources.backend}",
			"${resources.back end.outputs.url}",
			"${resources.backend.outputs.url",
		]) {
			expect(
				() => assertDriverProgram(program({ outputs: { e: value } })),
				value,
			).toThrow(/invalid output reference/);
		}
	});

	it("leaves a literal output value alone", () => {
		for (const value of [
			"https://bold-hyena-681.convex.cloud",
			"static",
			"",
			"resources.backend.outputs.url",
		]) {
			expect(
				() => assertDriverProgram(program({ outputs: { e: value } })),
				value,
			).not.toThrow();
		}
	});

	it("checks every output, not just the first", () => {
		expect(() =>
			assertDriverProgram(
				program({
					outputs: {
						good: "${resources.backend.outputs.url}",
						bad: "${resources.gone.outputs.url}",
					},
				}),
			),
		).toThrow(/unresolved output reference/);
	});

	it("accepts a program with no outputs at all", () => {
		expect(() => assertDriverProgram(program({ outputs: {} }))).not.toThrow();
	});

	it("returns the program it was given", () => {
		const input = program();
		expect(assertDriverProgram(input)).toBe(input);
	});
});
