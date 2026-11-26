/**
 * The emit-side assert for Convex driver programs.
 *
 * Convex is a closed BaaS: it exposes a deploy surface, not infrastructure
 * state, so HoBo emits a *driver program* rather than IaC (ADR-0144's
 * thin-adapter rule). This assert is the last thing that runs before a program
 * leaves the package.
 *
 * **Output references have to resolve here or they never will.** A program's
 * outputs are `${resources.<name>.outputs.<field>}` strings that Convex
 * dereferences at deploy time. A reference to a resource that is not in the
 * program, or to a field that resource does not declare, becomes a deploy that
 * fails *inside Convex* with an error about a template — traceable back to
 * HoBo only by someone who already knows to look.
 *
 * **A duplicate resource name makes every reference to it ambiguous**, and
 * Convex would resolve to whichever it saw last. That is a silent wrong answer
 * rather than a failure, which is why the assert refuses rather than
 * de-duplicating.
 *
 * **A literal output value is left alone.** Not every output is a reference,
 * and rewriting or refusing a fixed endpoint would break a legitimate program.
 * Only strings that *claim* to be references are resolved.
 */
import { describe, expect, it } from "vitest";

import {
	assertDriverProgram,
	CONVEX_DRIVER,
	DRIVER_PROGRAM_API_VERSION,
	DRIVER_PROGRAM_KIND,
	type DriverProgram,
} from "../src/driver-program.js";

/** A minimal valid program, for tests that vary one field. */
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
		// The version is a contract with Convex's own parser. Naming what was
		// expected turns a rejection into a one-line fix.
		expect(() =>
			assertDriverProgram(program({ apiVersion: "v2" } as never)),
		).toThrow(new RegExp(DRIVER_PROGRAM_API_VERSION));
	});

	it("refuses a wrong kind", () => {
		// The kind is HoBo's own discriminator: an `iac-program` reaching a
		// driver runner would be executed by machinery built for a different
		// shape.
		expect(() =>
			assertDriverProgram(program({ kind: "iac-program" } as never)),
		).toThrow(/kind must be driver-program/);
	});

	it("refuses a wrong driver", () => {
		// The driver names which runner executes this. A `terraform` value here
		// would hand a Convex deploy call to an IaC backend.
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
		// A deploy of nothing that reported success is worse than a refusal.
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
		// The name is what an output reference resolves against, so an unnamed
		// resource is unreferenceable — and silently so.
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
		// Two resources under one name make every reference ambiguous, and
		// Convex would resolve to whichever it saw last — a silent wrong answer
		// rather than a failure.
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
		// This is the failure the assert exists for: a deploy that fails inside
		// Convex with an error about a template.
		expect(() =>
			assertDriverProgram(
				program({ outputs: { e: "${resources.gone.outputs.url}" } }),
			),
		).toThrow(/unresolved output reference/);
	});

	it("refuses a reference to a field the resource does not declare", () => {
		// The resource exists but does not produce this output. Convex would
		// interpolate nothing where an endpoint was expected.
		expect(() =>
			assertDriverProgram(
				program({ outputs: { e: "${resources.backend.outputs.nope}" } }),
			),
		).toThrow(/unresolved output reference/);
	});

	it("refuses a malformed template that still claims to be a reference", () => {
		// A half-written template is more dangerous than a plain string: it
		// reaches Convex and is interpolated into something unpredictable.
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
		// Not every output is a reference. A fixed endpoint is a legitimate
		// thing for a driver program to carry, and refusing it would break a
		// valid program over a rule that does not apply.
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
		// A program with one good reference and one bad one is still broken, and
		// stopping at the first would let the second through.
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
		// A program whose only effect is provisioning has nothing to hand back.
		expect(() => assertDriverProgram(program({ outputs: {} }))).not.toThrow();
	});

	it("returns the program it was given", () => {
		// The assert is used inline at emit sites, so it has to be usable as an
		// expression rather than a statement.
		const input = program();
		expect(assertDriverProgram(input)).toBe(input);
	});
});
