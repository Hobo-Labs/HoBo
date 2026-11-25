/**
 * The local IacProgram guard: the emit side's parse boundary.
 *
 * This provider cannot import `@hobo/iac-pulumi` — the package boundary forbids
 * adapter-to-adapter runtime edges — so `iac-program.ts` keeps a local mirror of
 * that adapter's program shape, and `assertLocalIacProgram` is what proves the
 * mirror still matches. It is the only thing standing between `realize()` and
 * emitting a program the real `validateIacProgram` would reject, which is a
 * failure that would otherwise surface at `pulumi up` — after credentials, after
 * a stack is selected, and a long way from the resolver that built the bad
 * reference.
 *
 * **Output references are the part worth the effort.** The three header fields
 * are a version check anyone would write. But `${resources.<name>.outputs.<key>}`
 * is a cross-resource pointer that the emit side constructs by string
 * concatenation, and there are two distinct ways to get it wrong: naming a
 * resource that is not in the program, and naming an output that resource does
 * not declare. Both produce a program that is structurally perfect and
 * un-deployable, and the guard has to catch each one — including references
 * buried inside nested resource inputs, since that is where resolvers actually
 * put them.
 *
 * **A string that merely looks like a reference is not one.** The guard only
 * inspects values starting with `${resources.`, so ordinary configuration
 * strings pass through untouched. That distinction is tested in both directions:
 * a plain string is left alone, and a malformed `${resources.` string is
 * refused rather than quietly ignored.
 *
 * Written against only the three shared exports, so the same file stands in
 * every provider that carries this mirror.
 */
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

/** A program's fields as a document may carry them: the declared type, or any other JSON. */
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

/** A well-formed program: every fixture field keeps its declared type. */
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

/**
 * A program as it arrives across a document boundary, carrying a field the
 * type forbids. Only the cases that test such a field build one this way.
 */
function documentProgram(over: ProgramFields): Program {
	const document = { ...program(), ...over };
	// SAFETY: the guard is the parse boundary for programs that crossed a
	// document boundary, so these cases hand it what the type forbids (a
	// foreign version, a resource list that is not a list). It re-checks every
	// field it relies on before trusting the declared type.
	return document as Program;
}

/** The message of the refusal, or a marker when there wasn't one. */
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
		// Parse-don't-validate: callers use the return value, so a guard that
		// checked and returned nothing would push them back to the unchecked one.
		const value = program();
		expect(assertLocalIacProgram(value)).toBe(value);
	});

	it("refuses an apiVersion it does not mirror", () => {
		// The mirror is only valid for the version it was written against; a
		// future program may mean something different by the same field names.
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
		// An empty program is not an empty success -- it means the resolver
		// produced nothing, and deploying it would silently tear down whatever
		// the stack previously held.
		expect(refusal(program({ resources: [] }))).toMatch(/at least one/u);
	});

	it("refuses a resource list that is not a list", () => {
		expect(refusal(documentProgram({ resources: {} }))).toMatch(
			/at least one/u,
		);
	});

	it("refuses a resource with no name", () => {
		// The name is the key every output reference points at; without it the
		// resource cannot be referenced and cannot be diffed across deploys.
		expect(refusal(program({ resources: [resource({ name: "" })] }))).toMatch(
			/missing name/u,
		);
	});

	it("refuses two resources sharing a name", () => {
		// Names index a Map here and address resources in Pulumi state. A
		// duplicate silently wins over its twin rather than erroring, so the
		// second resource would simply never be created.
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
		// Where resolvers actually put them. A guard that only looked at
		// top-level input values would pass every realistic broken program.
		expect(
			refusal(
				withInputs({
					connection: { primary: [{ dsn: "${resources.db.outputs.nope}" }] },
				}),
			),
		).toMatch(/unresolved output reference/u);
	});

	it("refuses a reference to a resource that is not in the program", () => {
		// The reference is structurally perfect; there is simply nothing to
		// resolve it against at deploy time.
		expect(
			refusal(withInputs({ url: "${resources.cache.outputs.endpoint}" })),
		).toMatch(/resources\.cache\.outputs\.endpoint/u);
	});

	it("refuses a reference to an output the resource does not declare", () => {
		// The other half, and the easier one to introduce: the resource exists,
		// so the name looks right, but nothing will ever populate that key.
		expect(
			refusal(withInputs({ url: "${resources.db.outputs.password}" })),
		).toMatch(/resources\.db\.outputs\.password/u);
	});

	it("refuses a malformed reference rather than ignoring it", () => {
		// It starts with `${resources.` so it was clearly meant to be one.
		// Passing it through as a literal would ship the placeholder text as a
		// connection string.
		expect(refusal(withInputs({ url: "${resources.db.endpoint}" }))).toMatch(
			/invalid output reference/u,
		);
	});

	it("leaves a string that is not a reference alone", () => {
		// Ordinary configuration must survive the guard untouched, including
		// strings that contain a dollar sign or braces for other reasons.
		expect(() =>
			assertLocalIacProgram(
				withInputs({ region: "eu-west-1", shell: "${HOME}/data", price: "$5" }),
			),
		).not.toThrow();
	});

	it("checks stack outputs by the same rule", () => {
		// Stack outputs are the program's public surface, so a dangling
		// reference there is the one an operator is most likely to consume.
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
