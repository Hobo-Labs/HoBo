import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { afterEach, test } from "vitest";
import {
	defineGrounding,
	description,
	generateDeclaredRegistrations,
	getTrainable,
	intent,
	PENDING_GROUNDINGS,
	resetTrainables,
	resolveDeclared,
	returns,
	scanDeclaredTrainables,
	trainable,
	training,
} from "../src/index.js";
import type { JsonValue } from "../src/json.js";

afterEach(() => {
	resetTrainables();
});

interface DecoratorBag {
	readonly kind: string;
}

function decoratorContext<T>(bag: DecoratorBag): T {
	// SAFETY: TC39 decorator context bag at this test boundary.
	return bag as never;
}

// ---------------------------------------------------------------------------
// Granular decorators, stage-3 call shape — all decorators optional.
// ---------------------------------------------------------------------------

test("stage-3: @intent/@returns + bare @trainable class compose and register", async () => {
	class Program {
		trainableMethod(name?: string): string {
			return name ? `Hello, ${name}!` : "Hello World!";
		}
	}
	const metadata: Record<PropertyKey, JsonValue> = {};
	const methodContext = decoratorContext<
		ClassMethodDecoratorContext<
			Program,
			(this: Program, input?: string) => string
		>
	>({
		kind: "method",
		name: "trainableMethod",
		metadata,
	});
	// Applied as decorators in app code; invoked programmatically here in
	// TC39 evaluation order (method decorators, then the class decorator).
	returns("Hello World! or Hello, <name>! when supplied")(
		Program.prototype.trainableMethod,
		methodContext,
	);
	intent("Produce a simple hello-world program")(
		Program.prototype.trainableMethod,
		methodContext,
	);
	trainable(
		Program,
		decoratorContext<ClassDecoratorContext>({
			kind: "class",
			name: "Program",
			metadata,
		}),
	);

	const record = getTrainable("Program.trainableMethod");
	assert.ok(record);
	assert.equal(record.fact.intent, "Produce a simple hello-world program");
	assert.equal(record.fact.contractRef, "decl://Program.trainableMethod");
	assert.equal(
		record.fact.output.returns?.description,
		"Hello World! or Hello, <name>! when supplied",
	);
	assert.deepEqual(record.fact.rubric, {}); // optional — none declared
	const run = resolveDeclared<string | undefined, string>(
		"Program.trainableMethod",
	);
	assert.equal(await run("Ada"), "Hello, Ada!");
});

test("stage-3 syntax: @intent decorates a class method under exactOptionalPropertyTypes", async () => {
	const fixture = await tsImport<{ readonly createIntent: string | undefined }>(
		fileURLToPath(new URL("./fixtures/todo-api.ts", import.meta.url)),
		import.meta.url,
	);

	assert.equal(fixture.createIntent, "Create a todo from text");
});

test("stage-3: bare @trainable class with NO other decorators infers everything", async () => {
	class Greeter {
		greet(name?: string): string {
			return name ? `Hi ${name}` : "Hi";
		}
	}
	trainable(
		Greeter,
		decoratorContext<ClassDecoratorContext>({
			kind: "class",
			name: "Greeter",
			metadata: {},
		}),
	);

	const record = getTrainable("Greeter.greet");
	assert.ok(record);
	assert.match(record.fact.intent, /^Inferred: implement Greeter\.greet/);
	assert.equal(record.fact.contractRef, "decl://Greeter.greet");
	assert.equal(
		await resolveDeclared<string, string>("Greeter.greet")("Bo"),
		"Hi Bo",
	);
});

// A field's example is kept as given; the manifest lowers it with
// JSON.stringify when the method registers, as it always has.
function pendingParam(method: string, name: ReturnType<typeof description>) {
	return {
		[PENDING_GROUNDINGS]: new Map([
			[method, { intent: "Greet", params: { name } }],
		]),
	};
}

interface Loop {
	self?: Loop;
}

test("a field's example reaches the options as given and is lowered to JSON at registration", () => {
	class Greeter {
		greet(name: string): string {
			return name;
		}
	}
	const example = { name: "Ada", greet: () => "hi" };
	trainable(
		Greeter,
		decoratorContext<ClassDecoratorContext>({
			kind: "class",
			name: "Greeter",
			metadata: pendingParam("greet", description("Who", example)),
		}),
	);
	const record = getTrainable("Greeter.greet");
	assert.ok(record);
	assert.equal(record.options.params?.name?.example, example);
	// JSON.stringify drops the function member.
	assert.equal(record.fact.params.name?.exampleJson, '{"name":"Ada"}');
});

test("a function example is dropped when lowered, as JSON.stringify drops it", () => {
	class Clock {
		now(zone: string): string {
			return zone;
		}
	}
	const example = () => "UTC";
	trainable(
		Clock,
		decoratorContext<ClassDecoratorContext>({
			kind: "class",
			name: "Clock",
			metadata: pendingParam("now", description("Who", example)),
		}),
	);
	const record = getTrainable("Clock.now");
	assert.ok(record);
	assert.equal(record.options.params?.name?.example, example);
	assert.equal(record.fact.params.name?.exampleJson, "");
});

test("a BigInt or circular example fails when the method registers, not when it is decorated", () => {
	const circular: Loop = {};
	circular.self = circular;
	for (const [label, example] of [
		["BigInt", 10n],
		["circular", circular],
	] as const) {
		class Counter {
			count(n: number): number {
				return n;
			}
		}
		const decorated = trainable(
			Counter.prototype.count,
			decoratorContext<
				ClassMethodDecoratorContext<
					Counter,
					(this: Counter, input: number) => number
				>
			>({
				kind: "method",
				name: "count",
				metadata: pendingParam("count", description("How many", example)),
			}),
		);
		assert.throws(
			() => decorated.call(new Counter(), 1),
			TypeError,
			`${label}: registration lowers the example`,
		);
		resetTrainables();
	}
});

test("description() doubles as a FieldDescription value for stage-3 params maps", () => {
	const field = description("Optional person to greet");
	assert.equal(field.description, "Optional person to greet");
	training(async (name?: string) => name ?? "world", {
		methodRef: "hello",
		intent: "Say hello.",
		contract: { input: { name: "string?" }, output: { greeting: "string" } },
		params: { name: field },
	});
	assert.equal(
		getTrainable("hello")?.fact.params.name?.description,
		"Optional person to greet",
	);
});

// ---------------------------------------------------------------------------
// Ambient declarations: `export declare class` never runs decorators —
// scanDeclaredTrainables honors the exact syntax statically.
// ---------------------------------------------------------------------------

const AMBIENT = `
@trainable
export declare class Program {
  @intent("Produce a simple hello-world program")
  @returns("Hello World! or Hello, <name>! when supplied")
  trainableMethod(
    @description("Optional person to greet")
    name?: string,
  ): string;
}
`;

test("scanDeclaredTrainables parses the ambient @trainable declare class", () => {
	const [declared] = scanDeclaredTrainables(AMBIENT);
	assert.ok(declared);
	assert.equal(declared.className, "Program");
	assert.equal(declared.ambient, true);
	const [op] = declared.operations;
	assert.ok(op);
	assert.equal(op.methodRef, "Program.trainableMethod");
	assert.equal(op.intent, "Produce a simple hello-world program");
	assert.equal(op.inferredIntent, false);
	assert.equal(op.returns, "Hello World! or Hello, <name>! when supplied");
	assert.equal(op.contractRef, "decl://Program.trainableMethod");
	assert.equal(op.outputType, "string");
	assert.deepEqual(op.parameters, [
		{
			name: "name",
			optional: true,
			type: "string",
			description: "Optional person to greet",
		},
	]);
});

test("scan: every decorator optional — bare @trainable declare class still scans", () => {
	const [declared] = scanDeclaredTrainables(`
@trainable
export declare class Plain {
  greet(name?: string): string;
}
`);
	assert.ok(declared);
	const [op] = declared.operations;
	assert.ok(op);
	assert.equal(op.inferredIntent, true);
	assert.match(op.intent, /^Inferred: implement Plain\.greet/);
	assert.deepEqual(op.parameters, [
		{ name: "name", optional: true, type: "string" },
	]);
});

test("generateDeclaredRegistrations emits a grounded, runnable defineGrounding", async () => {
	const [declared] = scanDeclaredTrainables(AMBIENT);
	assert.ok(declared);
	const generated = generateDeclaredRegistrations(declared);
	assert.match(generated, /^\/\/ Generated by hobo codegen — do not edit\.$/mu);
	assert.match(
		generated,
		/^\/\/ Registrations for the ambient @trainable class Program$/mu,
	);
	assert.match(
		generateDeclaredRegistrations(declared, { file: "src/program.ts" }),
		/^\/\/ Registrations for the ambient @trainable class Program in src\/program\.ts$/mu,
	);
	assert.match(generated, /defineGrounding\(/);
	assert.match(generated, /"methodRef": "Program\.trainableMethod"/);

	// The stub imports only names @hobo/runtime exports, so it compiles.
	const runtime = await import("../src/index.js");
	const imported = generated.match(
		/^import \{ ([^}]+) \} from "@hobo\/runtime";$/mu,
	);
	assert.ok(imported, "the stub imports from @hobo/runtime");
	for (const name of (imported[1] ?? "").split(",").map((n) => n.trim())) {
		assert.ok(Object.hasOwn(runtime, name), `@hobo/runtime exports ${name}`);
	}

	// The generated options object must actually register: evaluate it.
	const optionsJson = generated.slice(
		generated.indexOf("defineGrounding(") + "defineGrounding(".length,
		generated.lastIndexOf(");"),
	);
	const options = JSON.parse(optionsJson);
	const declaredFn = defineGrounding(options);
	assert.equal(declaredFn.methodRef, "Program.trainableMethod");
	assert.equal(
		getTrainable("Program.trainableMethod")?.fact.contractRef,
		"decl://Program.trainableMethod",
	);
});
